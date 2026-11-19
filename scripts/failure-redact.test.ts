import assert from "node:assert/strict";
import { test } from "node:test";
import { publicGuidance, publicTail, publicText } from "./failure/redact.ts";

const none = {};
const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const commit = "533199cfa3b565b9b7e14f69abae597f09828760";
const operation = "123e4567-e89b-12d3-a456-426614174000";
const kinds = [publicText, publicTail, publicGuidance];

test("an error's message loses every dotted name, under any ending and in any spelling", () => {
  for (const host of [
    "api.cloudflare.com",
    "Api.Example.Com",
    "example.com",
    "vendor.io",
    "db.prod.Internal",
    "db_primary.prod.internal",
    "Blob.core.windows.net",
    "münchen.example.de",
    "pr-41.preview.example.run",
    "db.acme.info",
    "pg.default.svc",
    "pr-41.preview.example.dev:8443",
  ]) {
    assert.equal(publicText(`connect to ${host} failed`, none), "connect to [host] failed", host);
    assert.equal(publicText(`build/${host}`, none), "build/[host]", host);
  }
  // Fetch names its own interfaces in the messages this rule exists for.
  assert.equal(
    publicText('Headers.append: "tok-made-up second-half" is an invalid header value.', none),
    "Headers.append: [value] is an invalid header value.",
  );
  assert.equal(
    publicText(`provider said "account 'Acme Corp' is suspended" and can't continue`, none),
    "provider said [value] and can't continue",
  );
});

test("a command's output keeps what a tail exists to show", () => {
  for (const kept of [
    "PoolWorker (Cloudflare.Worker) update failed",
    "src/pool/worker.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/pool/runtime/v2/handlers/threads.ts(7,1): error TS2304: Cannot find name 'x'.",
    "at run (.upstream/apps/hosted/cloud/src/v2/implementation/accounts.ts:12:5)",
    "see scripts/release/deploy.ts:317 and alchemy.run.ts at 12:30:45",
    "props.script.id changed and bindings.POOL.ID: present -> absent",
    "bun.lock, tsconfig.app.json, setup.local.sh and README.md changed in v1.2.3",
    "at process.processTicksAndRejections (node:internal/process/task_queues:103:5)",
    // No rule can tell a hostname written bare from the names above, so it stays too.
    "Route pr-41.preview.example.run/* is held by another Worker",
  ])
    for (const clean of [publicTail, publicGuidance]) assert.equal(clean(kept, none), kept);
});

test("urls, addresses, emails and home directories go from every kind of text", () => {
  for (const clean of kinds) {
    assert.equal(
      clean(
        "GET https://user:pw@api.example.com/v4/accounts/abc?token=1 from 203.0.113.7:443 and [2001:db8::1]:53",
        none,
      ),
      "GET [url] from [address] and [address]",
    );
    assert.equal(
      clean("fetch //cdn.example.com/x.js failed // a comment", none),
      "fetch [url] failed // a comment",
    );
    assert.equal(
      clean("mail jane.doe@example.org about /Users/jane/work/basalt and /home/runner/work", none),
      "mail [email] about ~/work/basalt and ~/work",
    );
    assert.equal(
      clean("listening on fe80::1, :::8787 and 2001:1234:5678:9012:3456:7890:1234:5678", none),
      "listening on [address], [address] and [address]",
    );
  }
});

test("a line written here keeps its wording and its evidence, and still loses credentials", () => {
  assert.equal(
    publicGuidance("Pass the policy's `include` list to the plan, or review 'release.json'.", none),
    "Pass the policy's `include` list to the plan, or review 'release.json'.",
  );
  // A refusal says exactly what it compared: content digests, a commit and an operation id.
  const evidence = `value: ${digest} (expected sha256-${digest.toUpperCase()}) digest=${digest} at ${commit} in operation ${operation}`;
  assert.equal(publicGuidance(evidence, none), evidence);
  assert.equal(
    publicTail(evidence, none),
    "value: [redacted] (expected [redacted]) [redacted] at [redacted] in operation [redacted]",
  );
  // A keyword in a sentence is a word; next to `=` or a quoted value it names a credential.
  assert.equal(
    publicGuidance(
      'The service rejected authorization: the token lacks scope. Rotate the token: see the runbook. It sent token=abc123 and {"token":"abc"}',
      none,
    ),
    'The service rejected authorization: the token lacks scope. Rotate the token: see the runbook. It sent token=[redacted] and {"token":[redacted]}',
  );
  // An account id or a key is no digest, whoever wrote the sentence around it.
  assert.equal(
    publicGuidance(
      "account 0123456789abcdef0123456789abcdef used key AKIAIOSFODNN7EXAMPLEabcdefghijklmnop1234",
      none,
    ),
    "account [redacted] used key [redacted]",
  );
});

test("credentials go by environment value, by shape and across lines", () => {
  const environment = {
    DEPLOY_PRIVATE_KEY:
      "-----BEGIN KEY-----\nline-one-of-the-key\nline-two-of-the-key\n-----END KEY-----",
    CLOUDFLARE_API_TOKEN: "cf-token-0123456789abcdef",
    DB_PASS: "correct-horse",
  };
  const tail = publicTail(
    [
      "starting",
      environment.DEPLOY_PRIVATE_KEY,
      `Authorization: Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
      "Authorization: Token abcdef123456",
      "cookie: session=abc; other=1",
      "sent Bearer abcdef123456 to the service with correct-horse",
      "account 0123456789abcdef0123456789abcdef password=hunter2hunter2",
      "psql --password hunter2hunter2 --api-token=cfshort12345",
      "passwd=hunter2hunter2 secret_key=abc123def456 X-Auth-Key: abc123def456ghi789",
      "connect admin:p/ssw0rd9@db and jane%40example.com:hunter2@db",
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
      "sent Bearer [redacted] to the service with [redacted]",
      "account [redacted] password=[redacted]",
      "psql --password [redacted] --api-token=[redacted]",
      "passwd=[redacted] secret_key=[redacted] X-Auth-Key: [redacted]",
      "connect [redacted]@db and [redacted]@db",
      "done",
    ].join("\n"),
  );
});

test("a line cut to its limit leaves no part of a credential behind", () => {
  const environment = { DEPLOY_API_TOKEN: "Zx9-made-up-secret-Qw7" };
  const key = "sk9LIVE4abcdEFGH123456789012345678901234";
  for (const clean of kinds) {
    // The cut would fall inside the value: whole values go before anything is cut.
    const byValue = clean(`see ${"a ".repeat(2040)}Zx9-made-up-secret-Qw7 sent`, environment);
    assert.ok(!byValue.includes("Zx9-"), byValue.slice(-80));
    // A key the cut divides is too short for the rule that knows its shape, so its word goes whole.
    const byShape = clean(`${"x ".repeat(2038)}${key} tail`, none);
    assert.ok(!byShape.includes("sk9LIVE"), byShape.slice(-80));
    assert.ok(byShape.endsWith("[cut]"));
  }
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
  assert.ok(lines.every((line) => line.length <= 512 && line.endsWith("[cut]")));
});
