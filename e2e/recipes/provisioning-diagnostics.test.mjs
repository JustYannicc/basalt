import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { Effect } from "effect";
import {
  bringRetriesForward,
  bringRolloutsForward,
  changeOutboxEmpty,
  openRollouts,
  provisioningHistory,
  provisioningMoved,
  provisioningSettled,
  repositoryFailures,
} from "./provisioning-diagnostics.mjs";

const job = (id, status, attempts) => ({
  id,
  kind: "member",
  status,
  attempts,
  available_at: "2026-11-22T20:47:32.008Z",
  updated_at: "2026-11-22T20:47:02.192Z",
});

test("the queue is settled only when no job waits or runs", () => {
  assert.equal(provisioningSettled([]), true);
  assert.equal(provisioningSettled([job("a", "succeeded", 1), job("b", "failed", 8)]), true);
  assert.equal(provisioningSettled([job("a", "succeeded", 1), job("b", "queued", 1)]), false);
  assert.equal(provisioningSettled([job("a", "running", 1)]), false);
});

test("a deploy's rollout queued for well after the measurement does not hold the settle", () => {
  const now = Date.parse("2026-11-25T12:55:30.000Z");
  const at = (ms) => new Date(now + ms).toISOString();
  const bundle = "basalt-pool-bundle:7518f356:reconcile-3:c5743dcb-d670-4f4a-9ef8-bde58e94dde7";
  const rotation = "basalt-pool-token:0123456789abcdef:6f1d2c3b-4a5e-4f6a-8b7c-9d0e1f2a3b4c";
  const catalog = "basalt-catalog-apps:e781022:2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
  const queued = (id, dueIn, attempts = 0) => ({
    ...job(id, "queued", attempts),
    available_at: at(dueIn),
  });
  // Deferred rollouts, due minutes from now, stay clear of the measurement.
  assert.equal(
    provisioningSettled(
      [queued(bundle, 120_000), queued(rotation, 900_000), queued(catalog, 900_000)],
      now,
    ),
    true,
  );
  // One that runs, or is due within the margin, may commit inside it, so it is waited for.
  assert.equal(provisioningSettled([job(bundle, "running", 1)], now), false);
  assert.equal(provisioningSettled([queued(bundle, 10_000, 1)], now), false);
  // The organization's own setup always holds the settle, pool access included.
  assert.equal(provisioningSettled([queued("member-setup", 900_000, 1)], now), false);
  assert.equal(provisioningSettled([job("basalt-pool-access:app_1", "running", 1)], now), false);
});

test("the deferral reads the database's clock, not the host's", () => {
  const bundle = "basalt-pool-bundle:7518f356:reconcile-3:c5743dcb-d670-4f4a-9ef8-bde58e94dde7";
  const due = "2026-11-25T12:57:30.000Z";
  const at = (observed) => [
    { ...job(bundle, "queued", 0), available_at: due, observed_at: observed },
  ];
  // Two minutes ahead of the database: deferred. Thirty seconds ahead: waited for.
  assert.equal(provisioningSettled(at("2026-11-25T12:55:30.000Z")), true);
  assert.equal(provisioningSettled(at("2026-11-25T12:57:00.000Z")), false);
});

test("a proof runs the organization's rollouts first and waits only for those", async () => {
  const bundle = "basalt-pool-bundle:7518f356:reconcile-3:c5743dcb-d670-4f4a-9ef8-bde58e94dde7";
  const jobs = [
    job(bundle, "queued", 0),
    job("basalt-pool-token:0123456789abcdef:6f1d2c3b", "succeeded", 1),
    job("member-setup", "running", 1),
  ];
  assert.deepEqual(
    openRollouts(jobs).map(({ id }) => id),
    [bundle],
  );
  const sent = [];
  await bringRolloutsForward({ run: async (query) => sent.push(query) }, "org_1");
  assert.match(sent[0].sql, /status = 'queued' and available_at > now\(\)/u);
  for (const prefix of ["basalt-pool-bundle:%", "basalt-pool-token:%", "basalt-catalog-apps:%"])
    assert.ok(sent[0].sql.includes(`'${prefix}'`), prefix);
  assert.deepEqual(sent[0].params, ["org_1"]);
});

test("the change outbox is empty only when no change waits for delivery", async () => {
  const outbox = (count) => ({
    run: (query) => {
      assert.deepEqual(query.params, ["organization:org_1"]);
      return Effect.succeed([{ count }]);
    },
  });
  assert.equal(await Effect.runPromise(changeOutboxEmpty(outbox(0), "org_1")), true);
  assert.equal(await Effect.runPromise(changeOutboxEmpty(outbox(2), "org_1")), false);
});

test("only a retry is brought forward; a first attempt keeps its own schedule", async () => {
  const sent = [];
  await bringRetriesForward({ run: async (query) => sent.push(query) }, "org_1");
  assert.equal(sent.length, 1);
  assert.match(sent[0].sql, /status = 'queued' and attempts > 0 and available_at > now\(\)/u);
  assert.deepEqual(sent[0].params, ["org_1"]);
});

test("an attempt that can fall inside the measurement invalidates it", () => {
  const first = [
    // Dispatched but never claimed, and unchanged: nothing ran.
    job("dispatched", "running", 0),
    job("waiting", "queued", 1),
    // Claimed before the first reading and still running at the second: in flight throughout.
    job("in-flight", "running", 2),
    job("attempted", "running", 0),
    job("finished", "queued", 1),
    job("gone", "queued", 1),
    job("done-before", "succeeded", 1),
  ];
  const second = [
    job("dispatched", "running", 0),
    job("waiting", "queued", 1),
    job("in-flight", "running", 2),
    job("attempted", "running", 1),
    job("finished", "succeeded", 1),
    job("done-before", "succeeded", 1),
    // Appeared between the readings: one already ran, one only waits.
    job("new-ran", "succeeded", 1),
    job("new-waits", "queued", 0),
  ];
  assert.deepEqual(
    provisioningMoved(first, second).map(({ id }) => id),
    ["in-flight", "attempted", "finished", "gone", "new-ran"],
  );
  const quiet = first.filter(({ id }) => ["dispatched", "waiting", "done-before"].includes(id));
  assert.deepEqual(provisioningMoved(quiet, quiet), []);
});

test("each job carries the reason of every attempt the hosted log recorded", () => {
  const pending = "basalt-pool-access:app_00000000-0000-4000-8000-000000000001";
  const member = "0b5e1c2a-9f3d-4e6b-8a7c-1d2e3f4a5b6c";
  const log = [
    // One JSON record on a line.
    `[Api] {"message":["Provisioning step failed",{"job":"${member}","reason":"dependency"}],"level":"WARN","timestamp":"2026-11-22T20:46:59.100Z"}`,
    // A record printed over several lines.
    "[Api] {",
    "[Api]   message: [",
    "[Api]     'Pool setup is waiting for the deploy to finish',",
    `[Api]     { job: '${pending}', reason: 'deploy_pending' }`,
    "[Api]   ],",
    "[Api]   level: 'INFO',",
    "[Api] }",
    `[Api] {"message":["Provisioning attempt failed",{"job":"${member}"}],"level":"WARN"}`,
    // A job this organization does not own is not attributed.
    '[Api] {"message":["Provisioning step failed",{"job":"someone-else","reason":"storage"}]}',
    "plain text that names no attempt",
  ].join("\n");
  const history = provisioningHistory(
    [job(member, "queued", 1), job(pending, "succeeded", 2), job("quiet", "succeeded", 1)],
    log,
  );
  assert.deepEqual(
    history.map(({ id, logged }) => [id, logged]),
    [
      [
        member,
        [
          { message: "Provisioning step failed", reason: "dependency" },
          { message: "Provisioning attempt failed" },
        ],
      ],
      [
        pending,
        [{ message: "Pool setup is waiting for the deploy to finish", reason: "deploy_pending" }],
      ],
      ["quiet", []],
    ],
  );
  assert.equal(history[0].attempts, 1);
  assert.equal(history[0].updated_at, "2026-11-22T20:47:02.192Z");
});

test("a catalog sweep's failed app is carried as its error class and app kind, nothing else", () => {
  const sweep = "basalt-catalog-apps:98f09e9e:eb6d947c-13b1-459e-9adb-7186b2add466";
  const secret = "app_5ec2e7aa-0000-4000-8000-00000000c0de";
  const organization = "OrgSentinelPrivate0000000000000000";
  // The hosted logger's record: the message and its fields, then the attempt's annotations.
  const record = (fields) => ({
    message: ["Catalog app update failed; the job will retry", fields],
    level: "WARN",
    timestamp: "2026-11-26T14:08:25.909Z",
    cause: "",
    annotations: { job: sweep, attempt: 6 },
    spans: {},
    fiberId: "#12",
  });
  const printed = (value) =>
    inspect(value, { depth: 6, breakLength: 80 })
      .split("\n")
      .map((line) => `[Api] ${line}`);
  const log = [
    // As Node prints a long record: over many lines, with the job well after the message.
    ...printed(
      record({ app: secret, organization, entry: "executor", cause: "VersionBuildFailed" }),
    ),
    // One JSON line.
    `[Api] ${JSON.stringify(record({ app: secret, organization, entry: "executor", cause: "StorageError" }))}`,
    // An unlisted cause and an entry that is not a plain name.
    `[Api] ${JSON.stringify(record({ app: secret, organization, entry: "https://catalog.example/apps/x?token=SECRET", cause: "Error: private message SECRET" }))}`,
    `[Api] ${JSON.stringify(record({ app: secret, organization, cause: "SomeNewTag" }))}`,
    // An app removed while the sweep ran.
    `[Api] ${JSON.stringify(record({ app: secret, organization, entry: "executor", cause: "AppNotFound" }))}`,
    // Another organization's sweep is not attributed.
    `[Api] ${JSON.stringify({ ...record({ app: secret, entry: "executor", cause: "SqlError" }), annotations: { job: "basalt-catalog-apps:other:1", attempt: 1 } })}`,
    `[Api] {"message":["Provisioning step failed",{"job":"${sweep}","reason":"storage"}],"level":"WARN"}`,
  ].join("\n");
  assert.ok(
    printed(record({ app: secret, organization, entry: "executor", cause: "x" })).length > 8,
  );
  const [history] = provisioningHistory([job(sweep, "running", 6)], log);
  assert.deepEqual(history.logged, [
    { message: "Catalog app update failed", cause: "VersionBuildFailed", app: "executor" },
    { message: "Catalog app update failed", cause: "StorageError", app: "executor" },
    { message: "Catalog app update failed", cause: "other" },
    { message: "Catalog app update failed", cause: "other" },
    { message: "Catalog app update failed", cause: "AppNotFound", app: "executor" },
    { message: "Provisioning step failed", reason: "storage" },
  ]);
  const published = JSON.stringify(history.logged);
  for (const sentinel of [
    secret,
    organization,
    "SECRET",
    "private",
    "catalog.example",
    "SomeNewTag",
    "retry",
  ])
    assert.ok(!published.includes(sentinel), sentinel);
});

test("a sweep line is attributed only by its own record's annotations", () => {
  const ours = "basalt-catalog-apps:98f09e9e:eb6d947c-13b1-459e-9adb-7186b2add466";
  const victim = "basalt-catalog-apps:98f09e9e:0d5c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
  const record = (job, fields) => ({
    message: ["Catalog app update failed; the job will retry", fields],
    level: "WARN",
    annotations: { job, attempt: 2 },
  });
  const printed = (worker, value) =>
    inspect(value, { depth: 6, breakLength: 80 })
      .split("\n")
      .map((line) => `[${worker}] ${line}`);
  const ownLines = printed(
    "Api",
    record(ours, { app: "app_1", organization: "org_1", entry: "executor", cause: "BuildBusy" }),
  );
  const other = printed(
    "Pool",
    record(victim, { app: "app_2", organization: "org_2", entry: "other", cause: "SqlError" }),
  );
  const forged = `[Api] ${JSON.stringify(record(ours, { entry: `x job='${victim}'`, cause: "SqlError" }))}`;
  const log = [
    // Another Worker's whole record, and then its closing brace alone, inside ours.
    ...ownLines.slice(0, 3),
    ...other,
    "[Pool] }",
    ...ownLines.slice(3),
    // A job named inside the message's fields does not move the line to that job.
    forged,
    // A line with no block of its own is not read into the record before it.
    `[Api] {"message":["Provisioning attempt failed",{"job":"${victim}"}],"level":"WARN","annotations":{"job":"${victim}"}}`,
    "2026-11-26T14:08:25Z [Api]   'Catalog app update failed; the job will retry',",
    // Unprefixed lines: a closed record of the other job, then a stray message line after it,
    // and one more than 40 lines below a record's start.
    ...inspect(record(victim, { entry: "other", cause: "SqlError" }), { breakLength: 40 }).split(
      "\n",
    ),
    "  'Catalog app update failed; the job will retry',",
    "{",
    ...Array.from({ length: 41 }, () => "  filler: 1,"),
    `  annotations: { job: '${victim}' },`,
    "  'Catalog app update failed; the job will retry',",
  ].join("\n");
  const [mine, theirs] = provisioningHistory(
    [job(ours, "running", 2), job(victim, "running", 1)],
    log,
  );
  assert.deepEqual(mine.logged, [
    { message: "Catalog app update failed", cause: "BuildBusy", app: "executor" },
    { message: "Catalog app update failed", cause: "SqlError" },
  ]);
  assert.deepEqual(theirs.logged, [
    { message: "Catalog app update failed", cause: "SqlError", app: "other" },
    { message: "Provisioning attempt failed" },
    { message: "Catalog app update failed", cause: "SqlError", app: "other" },
  ]);
});

test("a sweep's source failure carries its reason only when it is one of the SDK's words", () => {
  const sweep = "basalt-catalog-apps:edb15509:3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const line = (fields) =>
    JSON.stringify({
      message: ["Catalog app update failed; the job will retry", fields],
      level: "WARN",
      annotations: { job: sweep, attempt: 1 },
    });
  const multiLine = inspect(
    {
      message: [
        "Catalog app update failed; the job will retry",
        {
          app: "app_5ec2e7aa-0000-4000-8000-00000000c0de",
          organization: "OrgSentinelPrivate0000000000000000",
          entry: "provider-openai",
          cause: "SourceError",
          reason: "not-found",
        },
      ],
      level: "WARN",
      annotations: { job: sweep, attempt: 2 },
    },
    { depth: 6, breakLength: 80 },
  )
    .split("\n")
    .map((text) => `[Api] ${text}`);
  const log = [
    `[Api] ${line({ entry: "provider-openai", cause: "SourceError", reason: "git" })}`,
    ...multiLine,
    // A reason outside the list, or one that carries text, is dropped.
    `[Api] ${line({ entry: "provider-openai", cause: "SourceError", reason: "Error: SECRET /home/x" })}`,
    `[Api] ${line({ entry: "provider-openai", cause: "SourceError", reason: "lost" })}`,
    // Only a source failure's reason is published.
    `[Api] ${line({ entry: "provider-openai", cause: "StorageError", reason: "git" })}`,
  ].join("\n");
  const [history] = provisioningHistory([job(sweep, "running", 5)], log);
  assert.deepEqual(history.logged, [
    {
      message: "Catalog app update failed",
      cause: "SourceError",
      reason: "git",
      app: "provider-openai",
    },
    {
      message: "Catalog app update failed",
      cause: "SourceError",
      reason: "not-found",
      app: "provider-openai",
    },
    { message: "Catalog app update failed", cause: "SourceError", app: "provider-openai" },
    { message: "Catalog app update failed", cause: "SourceError", app: "provider-openai" },
    { message: "Catalog app update failed", cause: "StorageError", app: "provider-openai" },
  ]);
  const published = JSON.stringify(history.logged);
  for (const sentinel of ["SECRET", "/home", "lost", "OrgSentinel", "app_5ec2"])
    assert.ok(!published.includes(sentinel), sentinel);
});

test("repository failures carry their step, class, reason, status and categories, nothing else", () => {
  const gitLine = (fields) =>
    `[Api] ${JSON.stringify({
      message: ["Managed Git operation failed", fields],
      level: "WARN",
      annotations: { job: "basalt-catalog-apps:x:1", attempt: 1 },
    })}`;
  const coordinator = inspect(
    {
      message: ["Repository step failed", { step: "coordinator-token", error: "ArtifactsError" }],
      level: "WARN",
      annotations: {},
    },
    { depth: 6, breakLength: 40 },
  )
    .split("\n")
    .map((text) => `[ArtifactsCredentials] ${text}`);
  const log = [
    gitLine({
      reason: "git",
      type: "HttpError",
      status: 401,
      frames: ["    at secretFunction (/home/runner/SECRET/path.js:1:2)"],
      categories: ["fetch", "request", "secret-category"],
    }),
    gitLine({
      reason: "git",
      type: "HttpError",
      status: 401,
      frames: [],
      categories: ["fetch", "request"],
    }),
    ...coordinator,
    ...coordinator,
    // A message in the class, an unknown step, an impossible status: each dropped.
    `[Api] ${JSON.stringify({ message: ["Repository step failed", { step: "made-up", error: "Error: SECRET text" }] })}`,
    // Lowercase words and `instance.*` codes come from message text: dropped too.
    `[Api] ${JSON.stringify({ message: ["Repository step failed", { step: "credentials", error: "secretword", code: "instance.secrethost" }] })}`,
    // A tag with its provider code, and a transport failure with how it failed.
    `[ArtifactsCredentials] ${JSON.stringify({ message: ["Repository step failed", { step: "coordinator-create", error: "ArtifactsError", code: "NOT_FOUND" }] })}`,
    `[Api] ${JSON.stringify({ message: ["Repository step failed", { step: "initialize", error: "RpcCallError", code: "reset" }] })}`,
    gitLine({ reason: "lost", type: "TypeError", status: 9999 }),
    "an unrelated line",
  ].join("\n");
  assert.deepEqual(repositoryFailures(log), [
    {
      message: "Managed Git operation failed",
      error: "HttpError",
      reason: "git",
      status: 401,
      categories: ["request", "fetch"],
      count: 2,
    },
    {
      message: "Repository step failed",
      step: "coordinator-token",
      error: "ArtifactsError",
      count: 2,
    },
    { message: "Repository step failed", count: 1 },
    { message: "Repository step failed", step: "credentials", count: 1 },
    {
      message: "Repository step failed",
      step: "coordinator-create",
      error: "ArtifactsError",
      code: "NOT_FOUND",
      count: 1,
    },
    {
      message: "Repository step failed",
      step: "initialize",
      error: "RpcCallError",
      code: "reset",
      count: 1,
    },
    { message: "Managed Git operation failed", error: "TypeError", count: 1 },
  ]);
  const published = JSON.stringify(repositoryFailures(log));
  for (const sentinel of [
    "SECRET",
    "secret",
    "/home",
    "made-up",
    "lost",
    "9999",
    "frames",
    "instance.",
  ])
    assert.ok(!published.includes(sentinel), sentinel);
});
