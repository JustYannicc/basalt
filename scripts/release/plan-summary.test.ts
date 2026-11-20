import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedRows,
  destroyTargets,
  plannedReasons,
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

test("what remains after apply is named with the properties that differ, never their values", () => {
  assert.deepEqual(remainingRows(appliedSnapshot()), [
    {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      action: "update",
      changedProps: ["bindings", "compatibility"],
      bindings: ["POOL"],
      // Resolved resources inside props refer back to each other; the diff stops a few levels down.
      reasons: [
        "props.bindings.POOL.worker.container: changed",
        "props.bindings.POOL.worker.name: changed",
        "props.compatibility: absent -> <withheld>",
      ],
    },
  ]);
});

test("a row left after apply says why Alchemy plans it, binding path by binding path", () => {
  const binding = (hash: string) => ({
    bindings: [
      { type: "durable_object_namespace", name: "PoolContainer", className: "PoolContainer" },
    ],
    containers: [{ className: "PoolContainer", hash }],
  });
  const node = (data: unknown, recorded: unknown) => ({
    action: "update",
    props: { image: "same" },
    state: {
      status: "updated",
      props: { image: "same" },
      bindings: [{ sid: "PoolContainer", data: recorded }],
    },
    bindings: [{ sid: "PoolContainer", action: "update", data }],
  });
  const plan = {
    resources: {
      Changed: node(binding("b".repeat(16)), binding("a".repeat(16))),
      Same: node(binding("a".repeat(16)), binding("a".repeat(16))),
    },
    deletions: {},
  } as never;
  assert.deepEqual(plannedReasons(plan, "Changed"), [
    `bindings.PoolContainer.containers.0.hash: ${"a".repeat(16)} -> ${"b".repeat(16)}`,
  ]);
  // Planned as an update with nothing that differs: the provider's own diff asked for it.
  assert.deepEqual(plannedReasons(plan, "Same"), [
    "bindings.PoolContainer: update, no leaf differs",
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
      {
        fqn: "PoolWorker",
        type: "Cloudflare.Worker",
        action: "update",
        changedProps: [],
        bindings: [],
        reasons: [],
      },
      {
        fqn: "Seed",
        type: "Command.Exec",
        action: "create",
        changedProps: [],
        bindings: [],
        reasons: [],
      },
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

test("a destroy plan's targets are the kinds, names and ids its deleted rows record", () => {
  const deleted = (resourceType: string, attr: Record<string, unknown>) => ({
    action: "delete",
    state: { resourceType, attr },
  });
  const plan = {
    resources: {
      Worker: deleted("Cloudflare.Worker", {
        workerName: "basalt-test-pr-7-poolworker",
        bindings: [{ id: "shared-db" }],
      }),
      Kept: {
        action: "noop",
        state: {
          resourceType: "Cloudflare.Worker",
          attr: { workerName: "basalt-test-pr-7-router" },
        },
      },
      Odd: deleted("Cloudflare.SomethingNew", { name: "unknown-kind" }),
    },
    deletions: {
      Bucket: deleted("Cloudflare.R2.Bucket", { name: "vault-test-pr-7", jurisdiction: "eu" }),
    },
  };
  // Ids a row only refers to (a binding's target) are not targets, and an unknown type yields none.
  assert.deepEqual(destroyTargets(plan as never), [
    { kind: "Worker", id: "basalt-test-pr-7-poolworker" },
    { kind: "R2 bucket", id: "vault-test-pr-7" },
  ]);
});

test("a plan that did not settle says which rows and which properties still differ, in public", async () => {
  const { failureReport } = await import("./public-report.ts");
  const { ChangesRemainAfterApply } = await import("./plan-summary.ts");
  const node = (props: Record<string, unknown>, recorded: Record<string, unknown>) => ({
    action: "update",
    props,
    state: { props: recorded },
  });
  const after = {
    resources: [
      {
        fqn: "Api",
        resourceType: "Cloudflare.Worker",
        action: "update",
        bindings: [{ sid: "DB", action: "update" }],
      },
      { fqn: "Migrations", resourceType: "Command.Exec", action: "update", bindings: [] },
      { fqn: "Kept", resourceType: "Cloudflare.Worker", action: "noop", bindings: [] },
    ],
    summary: {},
    native: {
      resources: {
        Api: node({ main: "api.js", env: { A: "2" } }, { main: "api.js", env: { A: "1" } }),
        Migrations: node({ env: { X: "1" } }, { env: { X: "0" } }),
      },
      deletions: {},
    },
  } as never;
  const report = failureReport(ChangesRemainAfterApply.of(remainingRows(after)));
  assert.match(
    report.publicText,
    /ChangesRemainAfterApply: check=read-back .*remaining=Api \(Cloudflare\.Worker update: env, binding DB\)/u,
  );
  assert.doesNotMatch(report.publicText, /Migrations/u, "a command that re-runs is not a leftover");
  // Why each row is planned can show names and values, so it is in the private detail only.
  assert.doesNotMatch(report.publicText, /props\.env\.A/u);
  assert.match(report.detail, /props\.env\.A: <withheld> -> <withheld>/u);
});
