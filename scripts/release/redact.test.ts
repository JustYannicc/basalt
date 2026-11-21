import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./redact.ts";

test("every long value of the environment is taken out, whatever its name", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "cf-token-0123456789abcdef",
    POOL_DEPLOYMENT_KEY: "k3y!",
    SOME_NEW_VALUE: "0123456789abcdef0123",
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
    ALCHEMY_STAGE: "test-rehearsal-3",
    GITHUB_TOKEN: "ghs_0123456789abcdefghij",
  };
  const text = "/home/runner/work/basalt/basalt on test-rehearsal-3 with ghs_0123456789abcdefghij";
  assert.equal(
    redactSecrets(text, env),
    "/home/runner/work/basalt/basalt on test-rehearsal-3 with [redacted]",
  );
});

test("a value is taken out as written, trimmed, JSON-escaped and URL-encoded", () => {
  const env = { POOL_ADMIN_PASSWORD: 'p"a\\ss/w=rd!\n' };
  const text = [
    'raw p"a\\ss/w=rd!',
    'json "p\\"a\\\\ss/w=rd!\\n"',
    `url ${encodeURIComponent('p"a\\ss/w=rd!\n')}`,
  ].join("; ");
  assert.equal(redactSecrets(text, env), 'raw [redacted]; json "[redacted]"; url [redacted]');
});

test("credential shapes are taken out even when no env value matches", () => {
  const text =
    "connect postgresql://role:pw@host.example:6432/db failed; authorization: bearer abc.def sent; Basic dXNlcjpwYXNz";
  assert.equal(
    redactSecrets(text, {}),
    "connect postgresql://[redacted]@host.example:6432/db failed; authorization: bearer [redacted] sent; Basic [redacted]",
  );
});

test("two values that overlap are both taken out whole", () => {
  const env = { FIRST_SECRET: "abcdef-ghijkl", SECOND_SECRET: "ghijkl-mnopqr" };
  assert.equal(redactSecrets("x abcdef-ghijkl-mnopqr y", env), "x [redacted] y");
});
