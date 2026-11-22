import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { UnsafeSelectionBoundary } from "alchemy/Plan";
import type { ResourceState } from "alchemy/State/ResourceState";
import { failureReport } from "./public-report.ts";
import {
  makePlan,
  productionRows,
  retainedScratchRow,
  type PlanInput,
} from "./test/plan-fixture.ts";

// A filtered plan that Alchemy's planner stops with UnsafeSelectionBoundary, reported the way the
// release entry prints a stop in the plan phase. Each public line is compared whole, so nothing
// else from the message (a value, a mode, the planner's prose) can reach it unnoticed.
const inPlan = { phase: "plan", resources: [] };
const head = "Release stopped in plan: UnsafeSelectionBoundary (failed)";
const generic = `${head}. The message is in the sealed detail.`;

const named = (fields: string) => `${head}\n- UnsafeSelectionBoundary: ${fields}`;

/** Alchemy's own planner over production-shaped State; the selection boundary it raises. */
async function planned(context: TestContext, input: PlanInput) {
  const error = await makePlan(context, input).then(
    () => assert.fail("the plan was made"),
    (failure: unknown) => failure,
  );
  const report = failureReport(error, inPlan);
  // The planner's own sentence stays whole in the sealed detail.
  assert.match(report.detail, /UnsafeSelectionBoundary: /u);
  return report;
}

const raised = (message: string) => failureReport(new UnsafeSelectionBoundary({ message }), inPlan);

const rows = (changes: Record<string, Record<string, unknown>>) => {
  const all: Record<string, unknown> = productionRows();
  for (const [fqn, change] of Object.entries(changes))
    all[fqn] = { ...(all[fqn] as object), ...change };
  return all as Record<string, ResourceState>;
};

test("a filtered rename names its check and both names", async (context) => {
  const report = await planned(context, {
    declared: { renamedScratch: true },
    rows: { ...productionRows(), ScratchRecords: retainedScratchRow() },
    include: ["ScratchArchive"],
  });
  assert.equal(
    report.publicText,
    named("check=rename-across-selection from=ScratchRecords to=ScratchArchive"),
  );
  assert.match(report.detail, /cannot migrate 'ScratchRecords' to 'ScratchArchive'/u);
});

test("a filtered recovery from deleting in another mode names its resource, not the modes", async (context) => {
  const report = await planned(context, {
    rows: rows({ PoolWorker: { status: "deleting", providerMode: "local" } }),
    include: ["PoolWorker"],
  });
  assert.equal(report.publicText, named("check=mode-switch-while-deleting resource=PoolWorker"));
});

test("detaching a selected consumer with unselected consumers names all three", async (context) => {
  const report = await planned(context, {
    declared: { vaultBinding: false },
    rows: rows({
      VaultAttachments: { downstream: ["PoolWorker"] },
      PoolWorker: { downstream: ["PoolDatabase"] },
    }),
    include: ["PoolWorker", "VaultAttachments"],
  });
  assert.equal(
    report.publicText,
    named(
      "check=detach-with-unselected-consumers source=VaultAttachments consumer=PoolWorker unselected=PoolDatabase",
    ),
  );
});

test("a filtered replacement beside recorded bindings names the evidence", async (context) => {
  const report = await planned(context, {
    rows: rows({ VaultAttachments: { status: "replacing" } }),
    include: ["VaultAttachments"],
  });
  assert.equal(
    report.publicText,
    named(
      "check=replace-with-unproven-history resource=VaultAttachments unselected=PublicSiteWaitlist bindingEvidence=ArtifactsCredentials",
    ),
  );
});

test("a filtered replacement with unselected dependents names them", async (context) => {
  const all = productionRows();
  const report = await planned(context, {
    rows: { VaultAttachments: { ...all.VaultAttachments, status: "replacing" } as ResourceState },
    include: ["VaultAttachments"],
  });
  assert.equal(
    report.publicText,
    named(
      "check=replace-with-unselected-dependents resource=VaultAttachments unselected=PoolContainer,PoolWorker",
    ),
  );
});

test("a selected row without downstream history names the unselected rows", async (context) => {
  const report = await planned(context, {
    rows: rows({ VaultAttachments: { downstream: undefined } }),
    include: ["VaultAttachments"],
  });
  assert.equal(
    report.publicText,
    named(
      "check=incomplete-downstream-history resource=VaultAttachments unselected=ArtifactsCredentials,PoolContainer,PoolDatabase,PoolObservationSecrets,PoolWorker,PublicSiteWaitlist",
    ),
  );
});

// The fixture's stack declares no Action and no Output that hides a dependency from selection, and
// keeping binding evidence alive needs a delete the planner refuses earlier, so these four are
// raised with the planner's exact template (alchemy/src/Plan.ts). The drift test below holds every
// template to the installed planner's own text.
test("an Action reusing a resource's FQN names the Action", () => {
  assert.equal(
    raised(
      "Filtered Action 'HomeMigration' cannot overwrite persisted resource state. Finish resource cleanup before reusing its FQN for an Action.",
    ).publicText,
    named("check=action-overwrites-state action=HomeMigration"),
  );
});

test("an unselected dependency found while evaluating outputs names it", () => {
  assert.equal(
    raised(
      "Output evaluation discovered unselected dependency 'PoolDatabase'. Declare the dependency explicitly or run a full deployment.",
    ).publicText,
    named("check=unselected-dependency dependency=PoolDatabase"),
  );
});

test("discarding the last binding evidence names the unselected rows, at most eight", () => {
  const unselected = Array.from({ length: 10 }, (_, index) => `Resource${index}`);
  assert.equal(
    raised(
      `Cannot discard the last historical binding evidence while persisted nodes are unselected: ${unselected.join(", ")}. Select them or run a full deployment.`,
    ).publicText,
    named(`check=last-binding-evidence unselected=${unselected.slice(0, 8).join(",")},+2 more`),
  );
});

test("missing downstream history on a replacement names where it is missing", () => {
  assert.equal(
    raised(
      "Cannot replace or collect old generations of 'PoolWorker' while 'ScratchRecords' is unselected. Historical dependencies missing from 'ScratchRecords' cannot be proven safe; run a full deployment.",
    ).publicText,
    named(
      "check=replace-with-unproven-history resource=PoolWorker unselected=ScratchRecords incompleteHistory=ScratchRecords",
    ),
  );
});

test("a message no template matches keeps the generic line", () => {
  for (const message of [
    "Filtered Action 'PoolWorker' cannot overwrite persisted resource state.",
    "A future planner check about 'PoolWorker'. Run a full deployment.",
    "",
  ])
    assert.equal(raised(message).publicText, generic, message);
  // Another error class with a selection-boundary sentence is not one.
  assert.equal(
    failureReport(
      {
        _tag: "InvalidResourceSelection",
        message:
          "Output evaluation discovered unselected dependency 'PoolDatabase'. Declare the dependency explicitly or run a full deployment.",
      },
      inPlan,
    ).publicText,
    "Release stopped in plan: InvalidResourceSelection (failed). The message is in the sealed detail.",
  );
});

test("a name that is not a plain resource name prints as withheld, and the check still prints", () => {
  const dependency = (name: string) =>
    `Output evaluation discovered unselected dependency '${name}'. Declare the dependency explicitly or run a full deployment.`;
  for (const name of [
    "Pool Worker",
    'Pool"Worker',
    "Pool/Worker",
    "pool.example.org/x",
    // Hosts, ids and token shapes that hold no slash, quote or space.
    "api.example.com",
    "x.y.z.internal",
    "a23e4567-e89b-12d3-a456-426614174000",
    "AKIAABCDEFGHIJKLMNOP",
    "Bearer_tok-AbCdEfGhIjKlMnOpQrStUvWxYz01234567",
    "Pool-Worker",
    "Pool_Worker",
    "abcdef0123456789abcdef0123456789",
    "1PoolWorker",
    `P${"o".repeat(121)}`,
  ])
    assert.equal(
      raised(dependency(name)).publicText,
      named("check=unselected-dependency dependency=[withheld]"),
      name,
    );
  // A quote ends the template's quoted name, so the message matches no sentence at all.
  assert.equal(raised(dependency("Pool'Worker")).publicText, generic);
  // One name that is not plain hides only itself: production's routes carry a dotted, dashed id.
  assert.equal(
    raised(
      "Cannot replace or collect old generations of 'PoolWorker' while dependents are unselected: PoolDatabase, host name, AppHostBypass-app.example.org. Select them or run a full deployment.",
    ).publicText,
    named(
      "check=replace-with-unselected-dependents resource=PoolWorker unselected=PoolDatabase,[withheld],[withheld]",
    ),
  );
});

test("the sealed detail keeps the planner's whole message", () => {
  const message =
    "Cannot switch provider mode for 'PoolWorker' during filtered recovery from deleting. Finish interrupted destruction in its recorded 'local' mode before deploying in 'live' mode; a full mode-switch deployment is not a safe recovery.";
  const report = raised(message);
  assert.equal(report.publicText, named("check=mode-switch-while-deleting resource=PoolWorker"));
  assert.equal(report.detail, `${head}: UnsafeSelectionBoundary: ${message}`);
});

test("every template's fixed text is the installed planner's own", async () => {
  // A reworded sentence in an Alchemy bump would otherwise fall back to the generic line unseen.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { CHECKS } = await import("./selection-boundary.ts");
  const planner = await readFile(fileURLToPath(import.meta.resolve("alchemy/Plan")), "utf8");
  for (const [check, sentence] of CHECKS) {
    const fragments = sentence
      // Placeholders and the few regex constructs the sentences use (an alternation) split the prose.
      .split(/'<\w+>'|<\w+>|'\[a-z\]\+'|\(\?:|\)\??|\|/u)
      .map((fragment) => fragment.replace(/\\(.)/gu, "$1"))
      .filter((fragment) => fragment.length >= 8);
    assert.ok(fragments.length > 0, check);
    for (const fragment of fragments)
      assert.ok(planner.includes(fragment), `${check}: the planner no longer says "${fragment}"`);
  }
});
