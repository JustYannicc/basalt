import assert from "node:assert/strict";
import { test } from "node:test";
import { awsFailureSummary } from "./diagnostics.ts";

test("a child assertion retains its phase and source position through the wrapper", () => {
  const child = awsFailureSummary({
    code: 1,
    phase: "oauth",
    checks: 23,
    stderr:
      "AssertionError: credential=private-token\n at /private/checkout/e2e/aws/oauth.mjs:51:5",
  });
  const summary = awsFailureSummary({
    ...child,
    code: 1,
    timedOut: false,
    stderr: "AWS acceptance proof failed; private diagnostics retained.",
  });
  assert.deepEqual(summary, {
    phase: "oauth",
    checks: 23,
    code: 1,
    timedOut: false,
    kind: "assertion",
    location: "e2e/aws/oauth.mjs:51:5",
  });
  assert.equal(JSON.stringify(summary).includes("private-token"), false);
  assert.equal(JSON.stringify(summary).includes("/private/checkout"), false);
});

test("module-load failures need no runtime context or screenshot", () => {
  assert.deepEqual(
    awsFailureSummary({
      code: 1,
      stderr:
        "error: Cannot find package 'secret-cookie-value'\n at /checkout/e2e/aws/runtime.mjs:24:9",
    }),
    {
      phase: "module-load",
      code: 1,
      timedOut: false,
      kind: "module-resolution",
      location: "e2e/aws/runtime.mjs:24:9",
    },
  );
});

test("browser launch failures retain a safe kind through the wrapper", () => {
  const child = awsFailureSummary({
    code: 1,
    phase: "browser",
    checks: 151,
    stderr:
      "Error: browserType.launch: Target page, context or browser has been closed\nSocket path too long: /private/checkout/session-cookie",
  });
  const summary = awsFailureSummary({
    ...child,
    code: 1,
    timedOut: false,
    stderr: "AWS acceptance proof failed; private diagnostics retained.",
  });
  assert.deepEqual(summary, {
    phase: "browser",
    checks: 151,
    code: 1,
    timedOut: false,
    kind: "browser-launch",
  });
  assert.equal(JSON.stringify(summary).includes("session-cookie"), false);
});

test("the browser launch phase classifies errors without a recognizable exception name", () => {
  assert.deepEqual(
    awsFailureSummary({ phase: "browser", checks: 151, code: 1, stderr: "Opaque private error" }),
    { phase: "browser", checks: 151, code: 1, timedOut: false, kind: "browser-launch" },
  );
});

test("arbitrary context and exception payloads cannot enter the public summary", () => {
  const secret = "session-cookie-and-private-response";
  const summary = awsFailureSummary({
    code: secret,
    timedOut: secret,
    phase: secret,
    checks: secret,
    kind: secret,
    location: `/checkout/e2e/aws/runtime.mjs:42:1 ${secret}`,
    stdout: secret,
    stderr: `Error: ${secret}`,
    token: secret,
  });
  assert.deepEqual(summary, { phase: "unknown", code: null, timedOut: false, kind: "unknown" });
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("timeouts preserve the last completed phase and override child error kinds", () => {
  assert.deepEqual(
    awsFailureSummary({
      code: null,
      timedOut: true,
      phase: "server",
      checks: 2,
      kind: "assertion",
    }),
    { phase: "server", checks: 2, code: null, timedOut: true, kind: "timeout" },
  );
});
