import assert from "node:assert/strict";
import { test } from "node:test";
import { changedRows, remainingRows, type Snapshot } from "./plan-summary.ts";
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
