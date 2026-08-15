import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

const PROTOCOL_VERSION = 1;
const ACTOR_ENVIRONMENT = "SYMPOSE_PERSISTENT_RACE_ACTOR";
const RUN_ID_ENVIRONMENT = "SYMPOSE_PERSISTENT_RACE_RUN_ID";
const TEST_FILE_ENVIRONMENT = "SYMPOSE_PERSISTENT_RACE_TEST_FILE";
const TEST_NAME_ENVIRONMENT = "SYMPOSE_PERSISTENT_RACE_TEST_NAME";
const ACTOR_ROLE_ENVIRONMENT = "SYMPOSE_PERSISTENT_RACE_ACTOR_ROLE";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const PARENT_HARNESS_ENVIRONMENT_KEYS = [
  "SYMPOSE_UNIT_DB_TEMPLATE_ROOT",
  "SYMPOSE_UNIT_TEST_LANE",
  "SYMPOSE_UNIT_TEST_SCHEDULE_PATH",
] as const;
const RESERVED_ENVIRONMENT_KEYS = new Set([
  ACTOR_ENVIRONMENT,
  RUN_ID_ENVIRONMENT,
  TEST_FILE_ENVIRONMENT,
  TEST_NAME_ENVIRONMENT,
  ACTOR_ROLE_ENVIRONMENT,
]);

type RaceActorRole = "a" | "b";

type ActorIdentity = {
  readonly runId: string;
  readonly testFile: string;
  readonly testName: string;
  readonly role: RaceActorRole;
};

type ReadyFrame = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly kind: "ready";
  readonly pid: number;
} & ActorIdentity;

type ResponseFrame = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly kind: "response" | "shutdown-response";
  readonly id: string;
  readonly ok: boolean;
  readonly pid: number;
  readonly sequence: number;
  readonly code?: "ACTOR_EXECUTION_FAILED";
} & ActorIdentity;

type RequestFrame = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly kind: "request";
  readonly id: string;
  readonly sequence: number;
  readonly environment: Readonly<Record<string, string>>;
} & ActorIdentity;

type ShutdownFrame = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly kind: "shutdown";
  readonly id: string;
  readonly sequence: number;
} & ActorIdentity;

type ActorFrame = ReadyFrame | ResponseFrame;

type PendingResponse = {
  readonly kind: ResponseFrame["kind"];
  readonly sequence: number;
  readonly resolve: (frame: ResponseFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

export type PersistentRaceActorOptions = {
  readonly role: RaceActorRole;
  readonly testFile: string;
  readonly testName: string;
  readonly cwd?: string;
  readonly startTimeoutMs?: number;
};

export type PersistentRaceActor = {
  readonly role: RaceActorRole;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly request: (
    environment: Readonly<Record<string, string>>,
    timeoutMs?: number,
  ) => Promise<number>;
  readonly stop: (timeoutMs?: number) => Promise<void>;
};

export type PersistentRaceActorPair = readonly [
  PersistentRaceActor,
  PersistentRaceActor,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeFrameId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(value) && value.length <= 96;
}

function isSafeIdentityValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000\r\n]/u.test(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function frameKeysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertActorIdentity(identity: ActorIdentity): void {
  if (
    !isSafeIdentityValue(identity.runId) ||
    !isSafeIdentityValue(identity.testFile) ||
    !isSafeIdentityValue(identity.testName) ||
    (identity.role !== "a" && identity.role !== "b")
  ) {
    throw new Error("Persistent race actor identity is malformed.");
  }
}

function assertFrameIdentity(value: Record<string, unknown>, expected: ActorIdentity): void {
  if (
    value.runId !== expected.runId ||
    value.testFile !== expected.testFile ||
    value.testName !== expected.testName ||
    value.role !== expected.role
  ) {
    throw new Error("Persistent race actor frame identity mismatched.");
  }
}

function assertEnvironment(environment: Readonly<Record<string, string>>): void {
  if (!isRecord(environment)) throw new Error("Persistent race actor environment must be an object.");
  const keys = Object.keys(environment);
  if (keys.length > 64) throw new Error("Persistent race actor environment is too large.");
  for (const key of keys) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) ||
      RESERVED_ENVIRONMENT_KEYS.has(key)
    ) {
      throw new Error("Persistent race actor environment contains an invalid key.");
    }
    const value = environment[key];
    if (typeof value !== "string" || value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
      throw new Error("Persistent race actor environment contains an invalid value.");
    }
  }
}

function assertRequestFrame(
  value: unknown,
  identity: ActorIdentity,
): asserts value is RequestFrame | ShutdownFrame {
  if (!isRecord(value)) throw new Error("Persistent race actor request is malformed.");
  if (value.version !== PROTOCOL_VERSION) throw new Error("Persistent race actor request version mismatched.");
  if (!isSafeFrameId(value.id)) {
    throw new Error(
      `Persistent race actor request ID is malformed: ${typeof value.id === "string" ? value.id : typeof value.id}.`,
    );
  }
  if (!isSequence(value.sequence)) throw new Error("Persistent race actor request sequence is malformed.");
  if (!isSafeIdentityValue(value.runId)) throw new Error("Persistent race actor request run identity is malformed.");
  if (!isSafeIdentityValue(value.testFile)) throw new Error("Persistent race actor request test file is malformed.");
  if (!isSafeIdentityValue(value.testName)) throw new Error("Persistent race actor request test name is malformed.");
  if (value.role !== "a" && value.role !== "b") throw new Error("Persistent race actor request role is malformed.");
  assertFrameIdentity(value, identity);
  if (value.kind === "request") {
    if (!frameKeysAre(value, [
      "environment",
      "id",
      "kind",
      "role",
      "runId",
      "sequence",
      "testFile",
      "testName",
      "version",
    ])) {
      throw new Error("Persistent race actor request is malformed.");
    }
    assertEnvironment(value.environment as Readonly<Record<string, string>>);
    return;
  }
  if (value.kind === "shutdown" && frameKeysAre(value, [
    "id",
    "kind",
    "role",
    "runId",
    "sequence",
    "testFile",
    "testName",
    "version",
  ])) return;
  throw new Error("Persistent race actor request is malformed.");
}

function parseFrame(line: string): ActorFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("Persistent race actor response is not JSON.");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== PROTOCOL_VERSION ||
    !isPid(parsed.pid) ||
    !isSafeIdentityValue(parsed.runId) ||
    !isSafeIdentityValue(parsed.testFile) ||
    !isSafeIdentityValue(parsed.testName) ||
    (parsed.role !== "a" && parsed.role !== "b")
  ) {
    throw new Error("Persistent race actor response is malformed.");
  }
  if (parsed.kind === "ready") {
    if (!frameKeysAre(parsed, ["kind", "pid", "role", "runId", "testFile", "testName", "version"])) {
      throw new Error("Persistent race actor ready response is malformed.");
    }
    return parsed as unknown as ReadyFrame;
  }
  if (parsed.kind === "response" || parsed.kind === "shutdown-response") {
    if (!isSafeFrameId(parsed.id) || typeof parsed.ok !== "boolean" || !isSequence(parsed.sequence)) {
      throw new Error("Persistent race actor response is malformed.");
    }
    const expectedKeys = parsed.ok
      ? ["id", "kind", "ok", "pid", "role", "runId", "sequence", "testFile", "testName", "version"]
      : ["code", "id", "kind", "ok", "pid", "role", "runId", "sequence", "testFile", "testName", "version"];
    if (!frameKeysAre(parsed, expectedKeys) || (!parsed.ok && parsed.code !== "ACTOR_EXECUTION_FAILED")) {
      throw new Error("Persistent race actor response is malformed.");
    }
    return parsed as unknown as ResponseFrame;
  }
  throw new Error("Persistent race actor response has an unknown kind.");
}

function writeFrame(stream: Writable, frame: object): Promise<void> {
  const payload = `${JSON.stringify(frame)}\n`;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    stream.write(payload, "utf8", (error?: Error | null) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function openActorChannel(): { readonly input: Readable; readonly output: Writable } {
  const input = createReadStream(null as never, { fd: 3, autoClose: true });
  const output = createWriteStream(null as never, { fd: 4, autoClose: true });
  return { input, output };
}

type ProtocolStream = Readable | Writable;

function streamIsClosed(stream: ProtocolStream): boolean {
  const state = stream as ProtocolStream & {
    readonly closed?: boolean;
    readonly destroyed?: boolean;
  };
  return state.closed === true || state.destroyed === true;
}

function waitForStreamClosed(stream: ProtocolStream): Promise<void> {
  if (streamIsClosed(stream)) return Promise.resolve();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => {
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };
    const onClose = (): void => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

async function closeActorChannel(
  reader: Interface,
  input: Readable,
  output: Writable,
): Promise<void> {
  reader.close();
  const inputClosed = waitForStreamClosed(input);
  const outputClosed = waitForStreamClosed(output);
  if (!streamIsClosed(input)) input.destroy();
  if (!streamIsClosed(output)) output.end();
  await Promise.all([inputClosed, outputClosed]);
}

function restoreEnvironment(previous: ReadonlyMap<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!previous.has(key)) delete process.env[key];
  }
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withEnvironment<T>(
  environment: Readonly<Record<string, string>>,
  action: () => T | Promise<T>,
): Promise<T> {
  assertEnvironment(environment);
  const previous = new Map<string, string | undefined>(
    Object.keys(process.env).map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of Object.keys(environment)) process.env[key] = environment[key];
    return await action();
  } finally {
    restoreEnvironment(previous);
  }
}

function readActorIdentity(): ActorIdentity {
  if (process.env[ACTOR_ENVIRONMENT] !== "1") {
    throw new Error("Persistent race actor environment is missing.");
  }
  const runId = process.env[RUN_ID_ENVIRONMENT];
  const testFile = process.env[TEST_FILE_ENVIRONMENT];
  const testName = process.env[TEST_NAME_ENVIRONMENT];
  const role = process.env[ACTOR_ROLE_ENVIRONMENT];
  if (
    runId === undefined ||
    testFile === undefined ||
    testName === undefined ||
    (role !== "a" && role !== "b")
  ) {
    throw new Error("Persistent race actor identity environment is missing.");
  }
  const identity: ActorIdentity = { runId, testFile, testName, role };
  assertActorIdentity(identity);
  return identity;
}

export async function runPersistentRaceActor(
  handler: () => void | Promise<void>,
): Promise<void> {
  const identity = readActorIdentity();
  const { input, output } = openActorChannel();
  const reader = createInterface({ input });
  const seenRequestIds = new Set<string>();
  let expectedRequestSequence = 1;
  let shutdownSeen = false;
  let handlerFailure: unknown;
  try {
    await writeFrame(output, {
      ...identity,
      version: PROTOCOL_VERSION,
      kind: "ready",
      pid: process.pid,
    } satisfies ReadyFrame);
    for await (const line of reader) {
      let request: RequestFrame | ShutdownFrame;
      try {
        const parsed = JSON.parse(line) as unknown;
        assertRequestFrame(parsed, identity);
        request = parsed;
      } catch (error) {
        handlerFailure = error;
        break;
      }
      if (shutdownSeen) {
        handlerFailure = new Error("Persistent race actor received a frame after shutdown.");
        break;
      }
      if (seenRequestIds.has(request.id)) {
        handlerFailure = new Error("Persistent race actor request ID was repeated.");
        break;
      }
      if (request.sequence !== expectedRequestSequence) {
        handlerFailure = new Error("Persistent race actor request sequence was out of order.");
        break;
      }
      seenRequestIds.add(request.id);
      expectedRequestSequence += 1;
      if (request.kind === "shutdown") {
        await writeFrame(output, {
          ...identity,
          version: PROTOCOL_VERSION,
          kind: "shutdown-response",
          id: request.id,
          ok: true,
          pid: process.pid,
          sequence: request.sequence,
        } satisfies ResponseFrame);
        shutdownSeen = true;
        continue;
      }
      try {
        await withEnvironment(request.environment, handler);
        await writeFrame(output, {
          ...identity,
          version: PROTOCOL_VERSION,
          kind: "response",
          id: request.id,
          ok: true,
          pid: process.pid,
          sequence: request.sequence,
        } satisfies ResponseFrame);
      } catch (error) {
        handlerFailure = error;
        await writeFrame(output, {
          ...identity,
          version: PROTOCOL_VERSION,
          kind: "response",
          id: request.id,
          ok: false,
          pid: process.pid,
          sequence: request.sequence,
          code: "ACTOR_EXECUTION_FAILED",
        } satisfies ResponseFrame);
        break;
      }
    }
  } finally {
    await closeActorChannel(reader, input, output);
  }
  if (handlerFailure !== undefined) throw handlerFailure;
}

class PersistentRaceActorImpl implements PersistentRaceActor {
  readonly role: RaceActorRole;
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  private readonly identity: ActorIdentity;
  private readonly child: ChildProcess;
  private readonly input: Writable;
  private readonly output: Readable;
  private readonly reader: Interface;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly ready: Promise<void>;
  private readonly startTimeoutMs: number;
  private nextSequence = 0;
  private expectedResponseSequence = 1;
  private readonly requestIds = new Set<string>();
  private stopped = false;
  private readyReceived = false;
  private shutdownResponseReceived = false;
  private streamsClosed = false;
  private fatalError: Error | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly exit: Promise<void>;
  private resolveExit!: () => void;

  constructor(options: PersistentRaceActorOptions, runId: string) {
    this.role = options.role;
    this.identity = {
      runId,
      testFile: options.testFile,
      testName: options.testName,
      role: options.role,
    };
    assertActorIdentity(this.identity);
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const childEnvironment = { ...process.env };
    for (const key of PARENT_HARNESS_ENVIRONMENT_KEYS) delete childEnvironment[key];
    childEnvironment.SYMPOSE_UNIT_TEST_MODE = "serial";
    childEnvironment.SYMPOSE_UNIT_DB_TEMPLATE = "0";
    const child = spawn(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        options.testFile,
        "-t",
        options.testName,
      ],
      {
        cwd: options.cwd ?? process.cwd(),
        env: {
          ...childEnvironment,
          [ACTOR_ENVIRONMENT]: "1",
          [RUN_ID_ENVIRONMENT]: this.identity.runId,
          [TEST_FILE_ENVIRONMENT]: this.identity.testFile,
          [TEST_NAME_ENVIRONMENT]: this.identity.testName,
          [ACTOR_ROLE_ENVIRONMENT]: this.identity.role,
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.pid = child.pid ?? 0;
    if (!isPid(this.pid)) throw new Error("Persistent race actor did not receive a PID.");
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!input || !output || typeof (input as Writable).write !== "function" || typeof (output as Readable).on !== "function") {
      child.kill("SIGKILL");
      throw new Error("Persistent race actor channel was not created.");
    }
    this.input = input as Writable;
    this.output = output as Readable;
    this.reader = createInterface({ input: this.output });
    this.ready = new Promise<void>((resolvePromise, rejectPromise) => {
      this.resolveReady = resolvePromise;
      this.rejectReady = rejectPromise;
    });
    this.exit = new Promise<void>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
    this.reader.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.signalCode = signal;
      this.resolveExit();
      const cleanExit = code === 0 && signal === null && this.shutdownResponseReceived;
      if (!cleanExit && this.fatalError === undefined) {
        this.fail(new Error("Persistent race actor exited before completing its protocol."));
      }
    });
  }

  async start(): Promise<void> {
    if (this.readyReceived) return;
    await this.withTimeout(this.ready, this.startTimeoutMs, "startup");
  }

  async request(
    environment: Readonly<Record<string, string>>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<number> {
    await this.start();
    if (this.fatalError) throw this.fatalError;
    if (this.stopped || this.exitCode !== null || this.signalCode !== null) {
      throw new Error("Persistent race actor is not running.");
    }
    if (this.shutdownResponseReceived) {
      throw new Error("Persistent race actor has already shut down.");
    }
    if (this.pending.size !== 0) {
      throw new Error("Persistent race actor already has a request in flight.");
    }
    assertEnvironment(environment);
    const sequence = ++this.nextSequence;
    const id = this.createRequestId("request", sequence);
    const response = await this.send(
      {
        ...this.identity,
        version: PROTOCOL_VERSION,
        kind: "request",
        id,
        sequence,
        environment,
      } satisfies RequestFrame,
      id,
      sequence,
      "response",
      timeoutMs,
    );
    if (!response.ok) {
      throw new Error("Persistent race actor returned an invalid execution response.");
    }
    return 0;
  }

  async stop(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    let failure: unknown;
    try {
      if (this.exitCode !== null || this.signalCode !== null) {
        throw this.fatalError ?? new Error("Persistent race actor exited before shutdown.");
      }
      await this.start();
      if (this.fatalError) throw this.fatalError;
      if (this.pending.size !== 0) {
        throw new Error("Persistent race actor cannot shut down with a request in flight.");
      }
      const sequence = ++this.nextSequence;
      const id = this.createRequestId("shutdown", sequence);
      const response = await this.send(
        {
          ...this.identity,
          version: PROTOCOL_VERSION,
          kind: "shutdown",
          id,
          sequence,
        } satisfies ShutdownFrame,
        id,
        sequence,
        "shutdown-response",
        timeoutMs,
      );
      if (!response.ok) {
        throw new Error("Persistent race actor returned an invalid shutdown response.");
      }
      this.shutdownResponseReceived = true;
      this.endInputAfterShutdown();
      await this.withTimeout(this.exit, timeoutMs, "shutdown");
      if (this.exitCode !== 0 || this.signalCode !== null) {
        throw this.fatalError ?? new Error("Persistent race actor exited unsuccessfully.");
      }
      await this.closeProtocolStreams();
      if (!this.streamsClosed) throw new Error("Persistent race actor protocol streams remained open.");
    } catch (error) {
      failure = error;
      this.fail(error);
      this.terminateAfterFailure("SIGKILL");
      await this.withTimeout(this.exit, timeoutMs, "forced shutdown").catch(() => undefined);
      await this.closeProtocolStreams().catch(() => undefined);
    } finally {
      this.reader.close();
    }
    if (failure !== undefined) throw failure;
  }

  private handleLine(line: string): void {
    try {
      const frame = parseFrame(line);
      if (frame.kind === "ready") {
        if (this.readyReceived) throw new Error("Persistent race actor ready response was repeated.");
        assertFrameIdentity(frame, this.identity);
        if (frame.pid !== this.pid) throw new Error("Persistent race actor ready PID mismatched.");
        this.readyReceived = true;
        this.resolveReady();
        return;
      }
      if (!this.readyReceived) throw new Error("Persistent race actor sent a response before ready.");
      assertFrameIdentity(frame, this.identity);
      if (frame.pid !== this.pid) throw new Error("Persistent race actor response PID mismatched.");
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error("Persistent race actor response ID was not requested.");
      if (pending.kind !== frame.kind) throw new Error("Persistent race actor response kind was out of order.");
      if (
        frame.sequence !== pending.sequence ||
        frame.sequence !== this.expectedResponseSequence
      ) {
        throw new Error("Persistent race actor response sequence was out of order.");
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timeout);
      this.expectedResponseSequence += 1;
      if (frame.kind === "shutdown-response") this.shutdownResponseReceived = true;
      pending.resolve(frame);
    } catch (error) {
      this.fail(error);
    }
  }

  private async send(
    frame: RequestFrame | ShutdownFrame,
    id: string,
    sequence: number,
    kind: ResponseFrame["kind"],
    timeoutMs: number,
  ): Promise<ResponseFrame> {
    const response = new Promise<ResponseFrame>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `Persistent race actor ${this.role} response ${id} timed out (exit=${this.exitCode ?? "pending"}, signal=${this.signalCode ?? "none"}).`,
        );
        rejectPromise(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(id, {
        kind,
        sequence,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      });
    });
    try {
      await writeFrame(this.input, frame);
    } catch (error) {
      this.pending.delete(id);
      this.fail(error);
      throw error;
    }
    return response;
  }

  private createRequestId(kind: "request" | "shutdown", sequence: number): string {
    let id: string;
    do {
      id = `${this.identity.runId}-${kind}-${this.role}-${sequence}`;
    } while (this.requestIds.has(id));
    this.requestIds.add(id);
    return id;
  }

  private endInputAfterShutdown(): void {
    if (!this.input.destroyed && !this.input.writableEnded) this.input.end();
  }

  private async closeProtocolStreams(): Promise<void> {
    if (this.streamsClosed) return;
    this.reader.close();
    const inputClosed = waitForStreamClosed(this.input);
    const outputClosed = waitForStreamClosed(this.output);
    if (!streamIsClosed(this.input)) this.input.destroy();
    if (!streamIsClosed(this.output)) this.output.destroy();
    await Promise.all([inputClosed, outputClosed]);
    if (!streamIsClosed(this.input) || !streamIsClosed(this.output)) {
      throw new Error("Persistent race actor protocol streams remained open.");
    }
    this.streamsClosed = true;
  }

  private fail(caught: unknown): void {
    const error = caught instanceof Error ? caught : new Error("Persistent race actor failed.");
    if (this.fatalError === undefined) {
      this.fatalError = error;
      this.rejectReady(error);
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(this.fatalError);
      this.pending.delete(id);
    }
    if (!this.stopped) this.terminateAfterFailure("SIGKILL");
  }

  private terminateAfterFailure(signal: NodeJS.Signals): void {
    if (this.exitCode === null && this.signalCode === null && !this.child.killed) {
      this.child.kill(signal);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Persistent race actor ${phase} timed out.`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export async function startPersistentRaceActors(
  options: Omit<PersistentRaceActorOptions, "role"> & { readonly startTimeoutMs?: number },
): Promise<PersistentRaceActorPair> {
  const actors: PersistentRaceActorImpl[] = [];
  const runId = `run-${randomUUID()}`;
  try {
    const actorA = new PersistentRaceActorImpl({ ...options, role: "a" }, runId);
    actors.push(actorA);
    const actorB = new PersistentRaceActorImpl({ ...options, role: "b" }, runId);
    actors.push(actorB);
    await Promise.all(actors.map((actor) => actor.start()));
    return [actorA, actorB];
  } catch (error) {
    await Promise.all(actors.map((actor) => actor.stop().catch(() => undefined)));
    throw error;
  }
}

export async function stopPersistentRaceActors(
  actors: readonly PersistentRaceActor[],
): Promise<void> {
  await Promise.all(actors.map((actor) => actor.stop()));
}
