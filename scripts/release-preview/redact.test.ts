import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, redactor } from "./redact.ts";

test("public failure output carries the real error with every secret value removed", () => {
  const redact = redactor(
    { CLOUDFLARE_API_TOKEN: "cf-token-value-123", CLOUDFLARE_ACCOUNT_ID: "acct-identity-99", PATH: "/usr/bin" },
    { PREVIEW_SMOKE_PASSWORD: "hunter2-long", SHORT_KEY: "abc" },
  );
  const text = redact(
    "auth cf-token-value-123 for acct-identity-99 pw hunter2-long; Bearer abc.def; eyJa.eyJb.sig " +
      `${"a1".repeat(20)} kept /usr/bin abc`,
  );
  assert.equal(text, "auth [redacted] for [redacted] pw [redacted]; Bearer [redacted]; [redacted-jwt] [redacted-hex] kept /usr/bin abc");
  const failure = new AggregateError([new Error("state read failed: cf-token-value-123", { cause: new Error("bun: command not found: alchemy") })], "outer");
  const described = describeError(failure, redact);
  assert.match(described, /outer/);
  assert.match(described, /state read failed: \[redacted\]/);
  assert.match(described, /caused by: Error: bun: command not found: alchemy/);
  assert.doesNotMatch(described, /cf-token-value-123/);
});
