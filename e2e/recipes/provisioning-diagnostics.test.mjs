import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bringRetriesForward,
  provisioningHistory,
  provisioningMoved,
  provisioningSettled,
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
