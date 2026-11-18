import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedRows,
  destroyTargets,
  remainingRows,
  updatesWorkerWithoutReadiness,
  type Snapshot,
} from "./plan-summary.ts";
import { safeJson } from "./safe-json.ts";

/** A Worker node as apply leaves it: its binding prop resolved to a resource that points back. */
function appliedSnapshot(): Snapshot {
  const worker: Record<string, unknown> = { name: "pool" };
  const container: Record<string, unknown> = { className: "PoolContainer", worker };
  worker.container = container;
  const node = {
    action: "update",
    props: { main: "worker.js", bindings: { POOL: container }, compatibility: "2026-11-01" },
    state: { props: { main: "worker.js", bindings: { POOL: { className: "PoolContainer" } } } },
  };
  return {
    resources: [
      {
        fqn: "PoolWorker",
        resourceType: "Cloudflare.Worker",
        action: "update",
        bindings: [{ sid: "POOL", action: "update", binding: container } as never],
      },
      { fqn: "Untouched", resourceType: "Cloudflare.Worker", action: "noop", bindings: [] },
    ],
    summary: { update: 1, noop: 1 },
    native: { resources: { PoolWorker: node }, deletions: {} } as never,
  };
}

test("an applied plan with cyclic props summarises instead of throwing", () => {
  const snapshot = appliedSnapshot();
  const props = (snapshot.native.resources.PoolWorker as { props: object }).props;
  assert.throws(() => JSON.stringify(props), /cyclic|circular/iu);
  const rows = changedRows(snapshot);
  assert.deepEqual(rows, [
    {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      action: "update",
      changedProps: ["bindings", "compatibility"],
      bindings: [{ sid: "POOL", action: "update" }],
    },
  ]);
  assert.doesNotThrow(() => safeJson(rows, 2));
});

test("what remains after apply is named without props", () => {
  assert.deepEqual(remainingRows(appliedSnapshot()), [
    { fqn: "PoolWorker", type: "Cloudflare.Worker", action: "update" },
  ]);
});

test("safeJson marks only a real cycle; a shared object prints in full each time", () => {
  const shared = { id: 1 };
  assert.equal(safeJson({ a: shared, b: shared }), '{"a":{"id":1},"b":{"id":1}}');
  const loop: Record<string, unknown> = { id: 2 };
  loop.self = loop;
  assert.equal(safeJson({ loop }), '{"loop":{"id":2,"self":"[cycle]"}}');
  assert.equal(safeJson({ big: 10n }), '{"big":"10"}');
  assert.equal(safeJson(undefined), "null");
});

const rows = (...resources: Snapshot["resources"]): Snapshot =>
  ({ resources, summary: {}, native: { resources: {}, deletions: {} } }) as never;
const row = (fqn: string, resourceType: string, action: string) => ({
  fqn,
  resourceType,
  action,
  bindings: [],
});

test("a command that re-runs on every deploy is not a change left after apply", () => {
  const after = rows(
    row("PoolBackendBudgetRuntimeReady", "Command.Exec", "update"),
    row("PoolWorker", "Cloudflare.Worker", "noop"),
  );
  assert.deepEqual(remainingRows(after), []);
  assert.deepEqual(
    remainingRows(
      rows(row("PoolWorker", "Cloudflare.Worker", "update"), row("Seed", "Command.Exec", "create")),
    ),
    [
      { fqn: "PoolWorker", type: "Cloudflare.Worker", action: "update" },
      { fqn: "Seed", type: "Command.Exec", action: "create" },
    ],
  );
});

test("a PoolWorker update must carry the readiness command that waits for adoption", () => {
  const worker = row("PoolWorker", "Cloudflare.Worker", "update");
  assert.equal(updatesWorkerWithoutReadiness(rows(worker), "PoolWorker"), true);
  assert.equal(
    updatesWorkerWithoutReadiness(
      rows(worker, row("PoolBackendBudgetRuntimeReady", "Command.Exec", "update")),
      "PoolWorker",
    ),
    false,
  );
  assert.equal(
    updatesWorkerWithoutReadiness(
      rows(row("PoolWorker", "Cloudflare.Worker", "noop")),
      "PoolWorker",
    ),
    false,
  );
});

test("a destroy plan's targets are the names and ids its deleted rows record", () => {
  const deleted = (attr: Record<string, unknown>) => ({ action: "delete", state: { attr } });
  const plan = {
    resources: {
      Worker: deleted({
        workerName: "basalt-test-pr-7-poolworker",
        bindings: [{ id: "shared-db" }],
      }),
      Kept: { action: "noop", state: { attr: { workerName: "basalt-test-pr-7-router" } } },
    },
    deletions: { Bucket: deleted({ name: "vault-test-pr-7", jurisdiction: "eu" }) },
  };
  // Ids a row only refers to (a binding's target) are not targets.
  assert.deepEqual(destroyTargets(plan as never), [
    "basalt-test-pr-7-poolworker",
    "vault-test-pr-7",
  ]);
});
