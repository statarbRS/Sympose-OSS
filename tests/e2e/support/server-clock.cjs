const { readFileSync } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");

const RealDate = Date;
const root = resolve(process.cwd());
const configuredPath = process.env.SYMPOSE_E2E_CLOCK_PATH;
const clockPath = configuredPath ? resolve(configuredPath) : null;

if (
  clockPath &&
  (!isAbsolute(clockPath) || relative(root, clockPath).startsWith(".."))
) {
  throw new Error("The E2E clock must remain inside the current worktree.");
}

function currentMilliseconds() {
  if (clockPath) {
    try {
      const candidate = readFileSync(clockPath, "utf8").trim();
      const milliseconds = RealDate.parse(candidate);
      if (Number.isFinite(milliseconds) && new RealDate(milliseconds).toISOString() === candidate) {
        return milliseconds;
      }
    } catch {
      // An absent clock file intentionally means real wall time for every other E2E journey.
    }
  }
  return RealDate.now();
}

function E2EDate(...args) {
  if (!new.target) return new RealDate(currentMilliseconds()).toString();
  return args.length === 0
    ? Reflect.construct(RealDate, [currentMilliseconds()], new.target)
    : Reflect.construct(RealDate, args, new.target);
}

Object.setPrototypeOf(E2EDate, RealDate);
E2EDate.prototype = RealDate.prototype;
E2EDate.now = currentMilliseconds;
E2EDate.parse = RealDate.parse;
E2EDate.UTC = RealDate.UTC;
globalThis.Date = E2EDate;
