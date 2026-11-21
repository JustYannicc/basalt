import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./redact.ts";

test("every secret value of the environment is taken out, whatever its name", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "cf-token-0123456789abcdef",
    POOL_DEPLOYMENT_KEY: "k3y!",
    SOME_NEW_SECRETISH_VALUE: "0123456789abcdef0123",
    PLANETSCALE_ORGANIZATION: "basalt",
  };
  const text =
    "refused with cf-token-0123456789abcdef, key k3y!, value 0123456789abcdef0123, org basalt";
  assert.equal(
    redactSecrets(text, env),
    "refused with [redacted], key [redacted], value [redacted], org basalt",
  );
});

test("public runner and workflow values stay readable, GITHUB_TOKEN does not", () => {
  const env = {
    HOME: "/home/runner",
    RUNNER_TEMP: "/home/runner/work/_temp",
    GITHUB_WORKSPACE: "/home/runner/work/basalt/basalt",
    BASALT_RELEASE_CANDIDATE: "1a9ee3cc4124828651f73be5e639149de68797be",
    GITHUB_TOKEN: "ghs_0123456789abcdefghij",
  };
  const text =
    "/home/runner/work/basalt/basalt at 1a9ee3cc4124828651f73be5e639149de68797be with ghs_0123456789abcdefghij";
  assert.equal(
    redactSecrets(text, env),
    "/home/runner/work/basalt/basalt at 1a9ee3cc4124828651f73be5e639149de68797be with [redacted]",
  );
});

test("connection URLs and bearer tokens are taken out even when no env value matches", () => {
  const text =
    'connect postgresql://role:pw@host.example:6432/db failed; header "Authorization: Bearer abc.def-ghi"';
  assert.equal(
    redactSecrets(text, {}),
    'connect postgres://[redacted] failed; header "Authorization: Bearer [redacted]"',
  );
});

test("a value that contains another is taken out whole", () => {
  const env = {
    POOL_DATABASE_ADMIN_URL: "admin-secret-value-0123456789",
    ADMIN_PASSWORD: "secret-value",
  };
  assert.equal(redactSecrets("x admin-secret-value-0123456789 y", env), "x [redacted] y");
});
