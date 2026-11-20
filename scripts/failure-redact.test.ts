import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicGuidance, publicLine, publicTail, publicText } from "./failure/redact.ts";

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

test("a named credential goes whole, however its value is punctuated, quoted or passed", () => {
  for (const [input, output] of [
    // A password may hold any punctuation.
    [
      "host=db user=admin password=Xy7,kq9Zt;x&y} next",
      "host=db user=admin password=[redacted] next",
    ],
    // JSON inside JSON, and a line cut before the closing quote.
    ['{"body":"{\\"password\\":\\"s3cr3tvalue\\"}"}', '{"body":"{\\"password\\":[redacted]}"}'],
    ['{"password":"s3cr3tvalue cut off', '{"password":[redacted]'],
    ['gpg --passphrase "correct horse" --sign', "gpg --passphrase [redacted] --sign"],
    ["tool --password 'correct horse battery' run", "tool --password [redacted] run"],
    [
      "aws configure --secret-access-key s3cr3tvalue",
      "aws configure --secret-access-key [redacted]",
    ],
    // Another flag is never the value.
    ["psql --no-password --password s3cr3tvalue", "psql --no-password --password [redacted]"],
    [
      "STRIPE_KEY=s3cr3tvalue SENTRY_DSN=s3cr3tvalue NPM_AUTH=s3cr3tvalue GITHUB_SHA=abc",
      "STRIPE_KEY=[redacted] SENTRY_DSN=[redacted] NPM_AUTH=[redacted] GITHUB_SHA=abc",
    ],
    // A token that says what it is needs no digit to be one.
    [
      "pushed with ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ and xoxb-abcdefghijklmnopqrst",
      "pushed with [redacted] and [redacted]",
    ],
  ] as const)
    assert.equal(publicTail(input, none), output, input);
  // A command line is one thing: a flag and its value on two lines are read together.
  assert.equal(
    publicLine("deploy \\\n  --password \\\n  s3cr3tvalue \\\n  --go", none),
    "deploy --password [redacted] --go",
  );
});

test("an address is one thing at a time, and a path, an index or a clock time is none", () => {
  for (const clean of kinds) {
    assert.equal(
      clean("from=alice@example.com&to=bob@example.com|cc=carol@example.com", none),
      "from=[email]&to=[email]|cc=[email]",
    );
    assert.equal(
      clean("[00:22:03] step [2] read items[0] at [::1]:8080 and [2001:db8::1]", none),
      "[00:22:03] step [2] read items[0] at [address] and [address]",
    );
  }
  const frame =
    "at causeSquash (node_modules/.bun/effect@4.0.1/node_modules/effect/dist/internal/effect.js:149:39)";
  for (const clean of [publicTail, publicGuidance]) {
    assert.equal(clean(frame, none), frame);
    assert.equal(
      clean("see node_modules/@cloudflare/workers-types/index.d.ts", none),
      "see node_modules/@cloudflare/workers-types/index.d.ts",
    );
  }
});

test("a credential that spans lines goes line by line and as JSON writes it", () => {
  const environment = { DEPLOY_KEY: "made-up-first-half\nmade-up-second-half" };
  // A build tool prefixes every line; another system ends lines its own way.
  assert.equal(
    publicTail("#12 0.3 made-up-first-half\n#12 0.3 made-up-second-half", environment),
    "#12 0.3 [redacted]\n#12 0.3 [redacted]",
  );
  assert.equal(
    publicTail("made-up-first-half\r\nmade-up-second-half", environment),
    "[redacted]\n[redacted]",
  );
  assert.equal(
    publicGuidance(JSON.stringify({ key: environment.DEPLOY_KEY }), environment),
    '{"key":"[redacted]"}',
  );
  // Only its first line is left once a message is cut to one.
  assert.equal(
    publicGuidance("The key could not be read: made-up-first-half", environment),
    "The key could not be read: [redacted]",
  );
});

test("no rule is slow on a line built to make it so", () => {
  // Each of these once cost seconds for one line; the bound is a hundred times what they cost now.
  const lines = [
    "-".repeat(1365) + "pass_".repeat(546),
    "--" + "pass-".repeat(800),
    "pwd_".repeat(1000),
    "A".repeat(2000) + "KEY_".repeat(500),
    "a@".repeat(2000),
    ":".repeat(4000),
  ];
  const started = performance.now();
  for (const clean of kinds) for (const line of lines) clean(`${line}\n`.repeat(4), none);
  assert.ok(performance.now() - started < 2000);
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

test("a stack frame inside the checkout is printed from the repository root, in every kind", () => {
  const checkout = new URL("../", import.meta.url);
  const frames = [
    `    at deploy (${checkout.href}scripts/preview/lifecycle.ts:120:11)`,
    `    at ${fileURLToPath(checkout)}scripts/process.ts:48:5`,
  ];
  // Actions exports the checkout as `PWD`, a name the credential rule matches.
  const checkoutPath = fileURLToPath(checkout);
  for (const environment of [none, { PWD: checkoutPath.slice(0, -1), OLDPWD: checkoutPath }])
    for (const kind of [publicTail, publicGuidance, publicLine])
      assert.deepEqual(
        frames.map((frame) => kind(frame, environment).trim()),
        ["at deploy (scripts/preview/lifecycle.ts:120:11)", "at scripts/process.ts:48:5"],
        `${kind.name} ${Object.keys(environment).join(",")}`,
      );
  // A message still loses its dotted names, but never to an absolute path or a URL.
  for (const frame of frames)
    assert.match(publicText(frame, none), /^\s+at (?:deploy \()?scripts\//u);
  // A file URL outside the checkout names the machine and goes; a plain path outside it is printed
  // as before, under the home-directory rule.
  assert.equal(
    publicTail("    at file:///opt/hostedtoolcache/node/x.mjs:1:1", none),
    "    at [url]",
  );
  // Only a path that starts at the root loses it, not one that merely contains its text.
  assert.doesNotMatch(publicTail(`/mnt/snap${checkoutPath}x.ts`, none), /snapx\.ts/u);
  assert.equal(publicTail(`git+${checkout.href}`, none), "[url]");
});

test("the preview zone and the operator's accounts never print, however short or cased", () => {
  const environment = {
    TEST_STAGE_DOMAIN: "b.io",
    PLANETSCALE_ORGANIZATION: "acme",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  };
  for (const kind of kinds)
    assert.equal(
      kind("deployed app.pr-41.B.IO for acme in 0123456789abcdef0123456789abcdef", environment),
      "deployed [host] for [account] in [account]",
      kind.name,
    );
  // Only whole names: a longer word or host that merely contains one stays.
  assert.equal(
    publicTail("acme-corp and acmes at b.iox", environment),
    "acme-corp and acmes at b.iox",
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
  assert.ok(lines.every((line) => line.length <= 512 && line.endsWith("[cut]")));
});
