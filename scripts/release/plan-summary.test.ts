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
      waitsOn: {},
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
    `bindings.PoolContainer.containers[0].hash: ${"a".repeat(16)} -> ${"b".repeat(16)}`,
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
      Bucket: deleted("Cloudflare.R2.Bucket", {
        bucketName: "vault-test-pr-7",
        jurisdiction: "eu",
      }),
    },
  };
  // Ids a row only refers to (a binding's target) are not targets, and an unknown type yields none.
  assert.deepEqual(destroyTargets(plan as never), [
    { kind: "Worker", id: "basalt-test-pr-7-poolworker" },
    { kind: "R2 bucket", id: "vault-test-pr-7" },
  ]);
});

test("each kind's target is the attribute its delete path carries, as Alchemy records it", () => {
  const deleted = (resourceType: string, attr: Record<string, unknown>) => ({
    action: "delete",
    state: { resourceType, attr },
  });
  const plan = {
    resources: {
      // A Workflow records its host Worker too; only its own name is the Workflow's target.
      Flow: deleted("Cloudflare.Workflow", {
        workflowId: "wf-uuid",
        workflowName: "basalt-rehearsal-usage-test-rehearsal-1",
        className: "UsageWorkflow",
        scriptName: "basalt-rehearsal-api-test-rehearsal-1",
        accountId: "acct",
      }),
      Pool: deleted("Cloudflare.Hyperdrive", { hyperdriveId: "hd-1", accountId: "acct" }),
      Token: deleted("Cloudflare.ApiToken.AccountApiToken", {
        tokenId: "tok-1",
        accountId: "acct",
      }),
      Role: deleted("Planetscale.PostgresRole", {
        id: "role-1",
        name: "pscale_api_x",
        database: "basalt-preview-rehearsal-1",
        branch: "test-rehearsal-1",
        databaseName: "postgres",
      }),
      Branch: deleted("Planetscale.PostgresBranch", {
        name: "test-rehearsal-1",
        database: "basalt-preview-rehearsal-1",
        organization: "org",
      }),
      // The account's one Secrets Store is shared with production: never a target.
      Store: deleted("Cloudflare.SecretsStore", { storeId: "store-1", storeName: "default" }),
    },
    deletions: {},
  };
  assert.deepEqual(destroyTargets(plan as never), [
    { kind: "Workflow", id: "basalt-rehearsal-usage-test-rehearsal-1" },
    { kind: "Hyperdrive config", id: "hd-1" },
    { kind: "API token", id: "tok-1" },
    {
      kind: "PlanetScale role",
      id: "basalt-preview-rehearsal-1/branches/test-rehearsal-1/roles/role-1",
    },
    { kind: "PlanetScale branch", id: "basalt-preview-rehearsal-1/branches/test-rehearsal-1" },
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

/** A fresh plan whose one Container row the provider still updates, with its node's reason. */
const containerUpdate = (providerReason?: unknown, props: Record<string, unknown> = {}) =>
  ({
    resources: [
      { fqn: "Mock", resourceType: "Cloudflare.Container", action: "update", bindings: [] },
    ],
    summary: {},
    native: {
      resources: {
        Mock: {
          action: "update",
          props: { className: "Mock", ...props },
          state: { props: { className: "Mock" } },
          ...(providerReason === undefined ? {} : { providerReason }),
        },
      },
      deletions: {},
    },
  }) as never as Snapshot;

test("a row the provider updates for a word of its closed set says that word in public", async () => {
  const { failureReport } = await import("./public-report.ts");
  const { ChangesRemainAfterApply, providerReasons } = await import("./plan-summary.ts");
  assert.equal(providerReasons.length, 7);
  for (const word of providerReasons) {
    const rows = remainingRows(containerUpdate(word));
    assert.equal(rows[0]?.providerReason, word);
    const error = ChangesRemainAfterApply.of(rows);
    assert.deepEqual(error.remaining, [`Mock (Cloudflare.Container update: provider ${word})`]);
    assert.match(
      failureReport(error).publicText,
      new RegExp(`remaining=Mock \\(Cloudflare\\.Container update: provider ${word}\\)$`, "mu"),
    );
  }
});

test("a row with no provider word still says no named property", async () => {
  const { ChangesRemainAfterApply } = await import("./plan-summary.ts");
  const rows = remainingRows(containerUpdate());
  assert.equal("providerReason" in rows[0]!, false, "no field is added");
  assert.deepEqual(ChangesRemainAfterApply.of(rows).remaining, [
    "Mock (Cloudflare.Container update: no named property)",
  ]);
});

test("a reason outside the closed set is dropped, and none of its text reaches a line", async () => {
  const { failureReport } = await import("./public-report.ts");
  const { ChangesRemainAfterApply } = await import("./plan-summary.ts");
  const injected = [
    `sha256:${"a".repeat(64)}`,
    "0123456789abcdef0123456789abcdef",
    "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d",
    "registry.cloudflare.com",
    "https://fixture.example.invalid/v4/accounts/x",
    "application-not-found registry.cloudflare.com",
    "Application-Not-Found",
    "x".repeat(4096),
  ];
  const nonStrings = [42, true, null, ["application-not-found"], { word: "dev-differs" }];
  for (const reason of [...injected, ...nonStrings]) {
    const rows = remainingRows(containerUpdate(reason));
    assert.equal("providerReason" in rows[0]!, false, `${String(reason).slice(0, 40)} is dropped`);
    const error = ChangesRemainAfterApply.of(rows);
    assert.deepEqual(error.remaining, ["Mock (Cloudflare.Container update: no named property)"]);
    const report = failureReport(error);
    for (const text of injected)
      for (const shown of [report.publicText, report.detail, safeJson(rows)])
        assert.ok(!shown.includes(text), `${text.slice(0, 40)} never reaches a line`);
  }
});

test("a row with named properties prints as before, even when the provider named a word", async () => {
  const { ChangesRemainAfterApply } = await import("./plan-summary.ts");
  const rows = remainingRows(containerUpdate("image-input-differs", { instanceType: "basic" }));
  assert.deepEqual(ChangesRemainAfterApply.of(rows).remaining, [
    "Mock (Cloudflare.Container update: instanceType)",
  ]);
});
