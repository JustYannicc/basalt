import assert from "node:assert/strict";
import { test } from "node:test";
import { publicGuidance, publicTail, publicText } from "./failure/redact.ts";

const none = {};
const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const commit = "533199cfa3b565b9b7e14f69abae597f09828760";
const operation = "123e4567-e89b-12d3-a456-426614174000";

test("hosts go in any spelling and position, in text of either kind", () => {
  for (const host of [
    "api.cloudflare.com",
    "Api.Example.Com",
    "example.com",
    "db.prod.Internal",
    "nas.local",
    "db_primary.prod.internal",
    "blob.core.windows.net",
    "münchen.example.de",
    "api.vendor.sh",
    "docs.example.md",
    "worker.example.workers.dev",
    "pr-41.preview.example.dev:8443",
  ])
    for (const clean of [publicText, publicGuidance]) {
      assert.equal(clean(`connect to ${host} failed`, none), "connect to [host] failed", host);
      assert.equal(clean(`build/${host}`, none), "build/[host]", host);
    }
  // What follows a host stays, so a file named after one still reads as a file.
  assert.equal(
    publicText("certs/api.example.com.json is unreadable", none),
    "certs/[host].json is unreadable",
  );
});

test("names that only look like hosts stay, so a diagnostic still names its place", () => {
  for (const kept of [
    "PoolWorker (Cloudflare.Worker) update failed",
    "Cloudflare.R2.Bucket created",
    "src/pool/worker.ts(12,5): error TS2322",
    "see scripts/release/deploy.ts:317 and alchemy.run.ts",
    "scripts/failure-report.test.ts failed at 12:30:45",
    "Headers.append: invalid header value",
    "props.id changed and bindings.PoolRuntimeBlue: present -> absent",
    "bun.lock, tsconfig.app.json, index.dev.js and README.md changed",
    "at process.processTicksAndRejections (node:internal/process/task_queues:103:5)",
  ])
    for (const clean of [publicText, publicGuidance]) assert.equal(clean(kept, none), kept);
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
  assert.equal(
    publicText("listening on fe80::1 and :::8787", none),
    "listening on [address] and [address]",
  );
});

test("guidance keeps its wording, quoted names and digests, and still loses what must not leave", () => {
  assert.equal(
    publicGuidance("Pass the policy's `include` list to the plan, or review 'release.json'.", none),
    "Pass the policy's `include` list to the plan, or review 'release.json'.",
  );
  // A refusal says exactly what it compared: content digests, a commit and an operation id.
  const evidence = `value: ${digest} (expected ${commit}) in operation ${operation}`;
  assert.equal(publicGuidance(evidence, none), evidence);
  assert.equal(
    publicText(evidence, none),
    "value: [redacted] (expected [redacted]) in operation [redacted]",
  );
  assert.equal(
    publicGuidance(
      'Provider said: {"token":"abc"} at db.internal.example.com 10.0.0.5 for ops@example.com',
      none,
    ),
    'Provider said: {"token":[redacted]} at [host] [address] for [email]',
  );
  // A long mixed run that is no digest is a key, whoever wrote the sentence around it.
  assert.equal(
    publicGuidance("key AKIAIOSFODNN7EXAMPLEabcdefghijklmnop1234 was rejected", none),
    "key [redacted] was rejected",
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
      "Authorization: Token abcdef123456",
      "cookie: session=abc; other=1",
      "sent Bearer abcdef123456 to the service",
      "account 0123456789abcdef0123456789abcdef password=hunter2hunter2",
      "connect admin:hunter2@db and jane%40example.com:hunter2@db",
      "done",
    ].join("\n"),
    environment,
  );
  assert.equal(
    tail,
    [
      "starting",
      "[redacted]",
      "Authorization: [redacted]",
      "Authorization: [redacted]",
      "cookie: [redacted]",
      "sent Bearer [redacted] to the service",
      "account [redacted] password=[redacted]",
      "connect [redacted]@db and [redacted]@db",
      "done",
    ].join("\n"),
  );
});

test("a line cannot issue a workflow command or span lines", () => {
  assert.equal(publicText("::error::spoofed", none), ": :error::spoofed");
  assert.equal(publicText("   ::stop-commands::token", none), "   : :stop-commands::token");
  assert.equal(publicText("##[error]spoofed", none), "# #[error]spoofed");
  assert.equal(publicGuidance("first\n::warning::second", none), "first ::warning::second");
  assert.equal(publicGuidance("first ::warning::second", none), "first ::warning::second");
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
