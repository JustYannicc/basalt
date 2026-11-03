import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

export function parsePolicy(value: unknown) {
  assert.ok(array(value), "Flake policy must be a list");
  const entries = value.map((entry) => {
    assert.ok(object(entry));
    const { id, owner, fix, job, file, titles, signature } = entry;
    assert.ok(text(id) && /^[a-z0-9-]+$/.test(id));
    assert.ok(text(owner) && owner.trim());
    assert.ok(object(fix) && text(fix.carry) && /^\d{4}$/.test(fix.carry));
    assert.ok(fix.pullRequest === undefined || Number.isSafeInteger(fix.pullRequest));
    assert.ok(text(job) && /^[a-z0-9-]+$/.test(job));
    assert.ok(text(file) && /^[a-z0-9-]+\.spec\.ts$/.test(file));
    assert.ok(array(titles) && titles.length > 0 && titles.every(text));
    assert.ok(signature === "account-checksum-only" || signature === "remove-400-after-passed-body");
    return { id, owner, fix: { carry: fix.carry, pullRequest: fix.pullRequest }, job, file, titles, signature };
  });
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, "Duplicate flake ID");
  return entries;
}

function parseError(value: unknown) {
  assert.ok(object(value) && text(value.name) && text(value.message) && text(value.stack));
  assert.ok(value.diff === null || text(value.diff));
  return { name: value.name, message: value.message, stack: value.stack, diff: value.diff };
}

export function parseVerdict(value: unknown) {
  assert.ok(object(value) && value.version === 1);
  assert.ok(text(value.reason));
  // These fields are mandatory. Vitest's standard JSON report cannot establish their absence.
  assert.ok(array(value.unhandledErrors) && array(value.suiteErrors) && array(value.tests));
  const tests = value.tests.map((test) => {
    assert.ok(object(test) && text(test.file) && text(test.title) && text(test.state));
    assert.ok(array(test.errors));
    const primary = test.primary;
    let body = null;
    if (primary !== null) {
      assert.ok(object(primary) && text(primary.status) && array(primary.errors) &&
        text(primary.file) && text(primary.title));
      body = { status: primary.status, file: primary.file, title: primary.title, errors: primary.errors };
    }
    return {
      file: test.file, title: test.title, state: test.state,
      errors: test.errors.map(parseError),
      primary: body,
    };
  });
  return { reason: value.reason, unhandledErrors: value.unhandledErrors, suiteErrors: value.suiteErrors, tests };
}

function accountChecksum(error: ReturnType<typeof parseError>, source: string) {
  if (error.name !== "AssertionError" || !error.message.startsWith("expected ") || !error.diff) return false;
  const location = /\/e2e\/tests\/production-ops-database\.spec\.ts:(\d+):\d+/.exec(error.stack);
  if (!location || source.split("\n")[Number(location[1]) - 1]?.trim() !==
    "expect(after.target).toEqual(beforeApply.target);") return false;
  const changes = stripVTControlCharacters(error.diff).split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^[+-] (?:Expected|Received)/.test(line));
  const hashes = changes.map((line) => /^([+-])\s+"accounts": "([a-f0-9]{64})",?$/.exec(line));
  return hashes.length === 2 && hashes.every((match) => match !== null) &&
    hashes[0]![1] !== hashes[1]![1] && hashes[0]![2] !== hashes[1]![2];
}

export function classify(
  verdict: ReturnType<typeof parseVerdict>,
  policy: ReturnType<typeof parsePolicy>,
  job: string,
  databaseSource: string,
) {
  if (verdict.reason !== "failed" || verdict.unhandledErrors.length || verdict.suiteErrors.length ||
      verdict.tests.some((test) => !["passed", "failed", "skipped"].includes(test.state))) return null;
  const failures = verdict.tests.filter((test) => test.state === "failed");
  if (!failures.length || verdict.tests.some((test) => test.state !== "failed" && test.errors.length)) return null;
  const matched = [];
  for (const failure of failures) {
    if (failure.errors.length !== 1) return null;
    const error = failure.errors[0]!;
    const entry = policy.find((entry) => entry.job === job && entry.file === failure.file &&
      entry.titles.includes(failure.title) && (entry.signature === "account-checksum-only"
        ? accountChecksum(error, databaseSource)
        : error.name === "FixtureFailed" && error.message === "Fixture /remove failed (HTTP 400)" &&
          /\/e2e\/sdk\/fixtures\.ts:\d+:\d+/.test(error.stack) &&
          failure.primary?.status === "passed" && failure.primary.errors.length === 0 &&
          failure.primary.title === failure.title && failure.primary.file === failure.file));
    if (!entry) return null;
    matched.push({ id: entry.id, owner: entry.owner, fix: entry.fix, file: failure.file, title: failure.title });
  }
  return matched;
}
