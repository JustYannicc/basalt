import assert from "node:assert/strict";
import { test } from "node:test";
import { provisioningHistory, provisioningSettled } from "./provisioning-diagnostics.mjs";

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
