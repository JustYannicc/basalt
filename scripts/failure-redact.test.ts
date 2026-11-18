import assert from "node:assert/strict";
import { test } from "node:test";
import { publicGuidance, publicTail, publicText } from "./failure/redact.ts";

const none = {};

test("hosts go in any spelling and position, and names that only look like hosts stay", () => {
  for (const host of [
    "api.cloudflare.com",
    "api.Example.Com",
    "db.prod.Internal",
    "api.vendor.sh",
    "docs.example.md",
    "shop.example.py",
    "pr-41.preview.example.dev:8443",
    "api.example.com.Foo",
  ]) {
    assert.equal(publicText(`connect to ${host} failed`, none), "connect to [host] failed", host);
    assert.equal(publicText(`build/${host}`, none), "build/[host]", host);
  }
  for (const kept of [
    "PoolWorker (Cloudflare.Worker) update failed",
    "Cloudflare.R2.Bucket created",
    "src/pool/worker.ts(12,5): error TS2322",
    "see scripts/release/deploy.ts:317 and alchemy.run.ts",
    "Headers.append: invalid header value",
    "bun.lock and tsconfig.json changed",
  ])
    assert.equal(publicText(kept, none), kept);
});

test("urls, addresses, emails, home directories and quoted values go from text nobody here wrote", () => {
  assert.equal(
    publicText(
      "GET https://user:pw@api.example.com/v4/accounts/abc?token=1 from 203.0.113.7:443 and [2001:db8::1]:53",
      none,
    ),
    "GET [url] from [address] and [address]",
  );
  assert.equal(
    publicText("fetch //cdn.example.com/x.js failed // a comment", none),
    "fetch [url] failed // a comment",
  );
  assert.equal(
    publicText(
      "mail jane.doe@example.org about /Users/jane/work/basalt and /home/runner/work",
      none,
    ),
    "mail [email] about ~/work/basalt and ~/work",
  );
  assert.equal(
    publicText(`provider said "account 'Acme Corp' is suspended" and can't continue`, none),
    "provider said [value] and can't continue",
  );
});

test("guidance keeps its wording and quoted names, and still loses what must not leave", () => {
  assert.equal(
    publicGuidance("Pass the policy's `include` list to the plan, or review 'release.json'.", none),
    "Pass the policy's `include` list to the plan, or review 'release.json'.",
  );
  assert.equal(
    publicGuidance(
      'Provider said: {"token":"abc"} at db.internal.example.com 10.0.0.5 for ops@example.com',
      none,
    ),
    'Provider said: {"token":[redacted]} at [host] [address] for [email]',
  );
  // A property path is not a host; a name under a domain in common use is.
  assert.equal(
    publicGuidance("bindings.PoolRuntimeBlue: present -> absent on api.Example.Com", none),
    "bindings.PoolRuntimeBlue: present -> absent on [host]",
  );
});

test("credentials go by environment value, by shape and across lines", () => {
  const environment = {
    DEPLOY_PRIVATE_KEY:
      "-----BEGIN KEY-----\nline-one-of-the-key\nline-two-of-the-key\n-----END KEY-----",
    CLOUDFLARE_API_TOKEN: "cf-token-0123456789abcdef",
  };
  const tail = publicTail(
    [
      "starting",
      environment.DEPLOY_PRIVATE_KEY,
      `Authorization: Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
      "account 0123456789abcdef0123456789abcdef password=hunter2hunter2",
      "done",
    ].join("\n"),
    environment,
  );
  assert.equal(
    tail,
    "starting\n[redacted]\nAuthorization: Bearer [redacted]\naccount [redacted] password=[redacted]\ndone",
  );
});

test("a line cannot issue a workflow command or span lines", () => {
  assert.equal(publicText("::error::spoofed", none), ": :error::spoofed");
  assert.equal(publicText("   ::stop-commands::token", none), "   : :stop-commands::token");
  assert.equal(publicText("##[error]spoofed", none), "# #[error]spoofed");
  assert.equal(publicGuidance("first\n::warning::second", none), "first ::warning::second");
  assert.deepEqual(publicTail("ok\n::set-output name=x::y\n", none).split("\n"), [
    "ok",
    ": :set-output name=x::y",
  ]);
});

test("only the last sixty lines of output are kept, each bounded", () => {
  const output = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(2000)}`);
  const lines = publicTail(output.join("\n"), none).split("\n");
  assert.equal(lines.length, 60);
  assert.ok(lines[0]!.startsWith("line 140 "));
  assert.ok(lines.every((line) => line.length <= 512));
});
