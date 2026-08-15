import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/internal/jobs/speaker-reminders/route";
import {
  isAuthorizedAutomaticReminderJobRequest,
} from "@/server/services/speaker-operations/reminder-job-auth";

const directories: string[] = [];
const TOKEN = "a".repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("automatic speaker reminder job route", () => {
  it("uses a fixed-length bearer token comparison and fails closed for missing configuration", () => {
    const authorized = new Request("http://localhost/internal/jobs/speaker-reminders", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const wrong = new Request("http://localhost/internal/jobs/speaker-reminders", {
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });

    expect(isAuthorizedAutomaticReminderJobRequest(authorized, TOKEN)).toBe(true);
    expect(isAuthorizedAutomaticReminderJobRequest(wrong, TOKEN)).toBe(false);
    expect(isAuthorizedAutomaticReminderJobRequest(authorized, undefined)).toBe(false);
    expect(isAuthorizedAutomaticReminderJobRequest(authorized, "short")).toBe(false);
    expect(isAuthorizedAutomaticReminderJobRequest(new Request(authorized.url, {
      method: "POST",
      headers: { authorization: TOKEN },
    }), TOKEN)).toBe(false);
  });

  it("rejects unauthenticated requests before opening the configured database and returns no secret detail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-reminder-route-"));
    directories.push(directory);
    const databasePath = join(directory, "must-not-be-created.sqlite");
    vi.stubEnv("SYMPOSE_DB_PATH", databasePath);
    vi.stubEnv("SYMPOSE_REMINDER_JOB_TOKEN", TOKEN);
    const supplied = "b".repeat(64);

    const response = POST(new Request("http://localhost/internal/jobs/speaker-reminders", {
      method: "POST",
      headers: { authorization: `Bearer ${supplied}` },
    }));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(existsSync(databasePath)).toBe(false);
    expect(serialized).toContain("NOT_FOUND");
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(supplied);
    expect(serialized).not.toContain("authorization");
  });

  it("keeps authorization ahead of the database mutation and redacts job failures", () => {
    const source = readFileSync(
      resolve("src/app/internal/jobs/speaker-reminders/route.ts"),
      "utf8",
    );
    const authorizationGuard = source.indexOf("if (!isAuthorizedAutomaticReminderJobRequest");
    expect(authorizationGuard).toBeGreaterThan(-1);
    expect(authorizationGuard).toBeLessThan(source.indexOf("runAutomaticActionTaskReminderJob(getDb())"));
    expect(source).not.toContain("console.");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("request.json");
  });
});
