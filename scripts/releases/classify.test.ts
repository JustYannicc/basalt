import assert from "node:assert/strict";
import test from "node:test";
import { classifySnapshots, compareSourceSnapshots } from "./classify.ts";
import { artifact, patchManifest, pins, sha } from "./fixtures.test-helpers.ts";

test("reports exact Git and pin candidates and keeps an unproven Home update database-unknown", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.home = artifact("home", "v1.1.7", sha("d"), "3");
  const report = classifySnapshots({
    baseGitCommit: sha("1"),
    candidateGitCommit: sha("2"),
    basePins: base,
    candidatePins: candidate,
    homeComparison: { complete: true, files: [{ filename: "internal/http/server.go", patch: "@@" }] },
  });
  assert.equal(report.base.gitCommit, sha("1"));
  assert.equal(report.candidate.gitCommit, sha("2"));
  assert.equal(report.candidate.pins.home.tag, "v1.1.7");
  assert.equal(report.databaseChanged, true);
  assert.equal(report.evidence.database.sources[0]?.state, "unknown");
  assert.equal(report.workflowChanged, false);
});

test("flags Home database changes and fails closed when source proof is incomplete", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.home = artifact("home", "v1.1.7", sha("d"), "3");
  const changed = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    homeComparison: { complete: true, files: [{ filename: "internal/cluster/database_models.go" }] },
  });
  assert.equal(changed.databaseChanged, true);

  const unknown = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    homeComparison: { complete: false, files: [] },
  });
  assert.equal(unknown.databaseChanged, true);
  assert.equal(unknown.evidence.database.sources[0]?.state, "unknown");
});

test("flags tools migration files and workflow runtime step changes", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.tools.commit = sha("d");
  const migration = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    toolsComparison: { complete: true, files: [{ filename: "apps/hosted/cloud/src/implementation/migrations.ts" }] },
  });
  assert.equal(migration.databaseChanged, true);

  const workflow = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    toolsComparison: { complete: true, files: [{ filename: "apps/hosted/cloud/src/infrastructure/workflows.ts", patch: "-task('old')\n+task('new')" }] },
  });
  assert.equal(workflow.workflowChanged, true);
});

test("falls back from unrelated export histories to a complete tree comparison", async () => {
  let treeFallbacks = 0;
  const comparison = await compareSourceSnapshots({
    async compare() { throw new Error("No common ancestor"); },
    async compareTrees() {
      treeFallbacks++;
      return { complete: true, status: "diverged", aheadBy: 0, behindBy: 0, files: [{ filename: "apps/hosted/cloud/src/main.ts" }] };
    },
  }, "UsefulSoftwareCo/executor", sha("a"), sha("d"));
  assert.equal(treeFallbacks, 1);
  assert.equal(comparison?.complete, true);
  const base = pins();
  const candidate = structuredClone(base);
  candidate.tools.commit = sha("d");
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    toolsComparison: comparison,
  });
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, true);
  assert.equal(report.evidence.database.sources[0]?.state, "unknown");
  assert.equal(report.evidence.workflow.sources[0]?.state, "unknown");
});

test("only a complete docs/assets-only tools diff clears database and Workflow flags", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.tools.commit = sha("d");
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    toolsComparison: { complete: true, files: [
      { filename: "apps/marketing/README.md" },
      { filename: "apps/hosted/cloud/public/logo.svg" },
    ] },
  });
  assert.equal(report.databaseChanged, false);
  assert.equal(report.workflowChanged, false);
});

test("Home model structs outside migration paths remain database-unknown", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.home = artifact("home", "v1.1.7", sha("d"), "3");
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    homeComparison: { complete: true, files: [{ filename: "internal/models/account.go" }] },
  });
  assert.equal(report.databaseChanged, true);
  assert.equal(report.evidence.database.sources[0]?.state, "unknown");
});

test("node migrations are detected and arbitrary node ORM callers remain database-unknown", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.node = artifact("node", "v8.0.41", sha("d"), "3");
  const migration = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    nodeComparison: { complete: true, files: [{ filename: "internal/cluster/schema_migration.go" }] },
  });
  assert.equal(migration.databaseChanged, true);
  assert.equal(migration.evidence.database.sources[0]?.state, "changed");

  const model = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    nodeComparison: { complete: true, files: [{ filename: "internal/models/account.go" }] },
  });
  assert.equal(model.databaseChanged, true);
  assert.equal(model.evidence.database.sources[0]?.state, "unknown");
});

test("arbitrary tools runtime DDL callers and Workflow callers stay unknown", () => {
  const base = pins();
  const candidate = structuredClone(base);
  candidate.tools.commit = sha("d");
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    toolsComparison: { complete: true, files: [
      { filename: "apps/hosted/cloud/src/implementation/startup.ts", patch: "+runSql('CREATE TABLE account')" },
      { filename: "packages/apps/src/implementation/caller.ts", patch: "+step('new encrypted workflow identity')" },
    ] },
  });
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, true);
  assert.ok(report.evidence.database.sources.some((source) => source.state === "unknown"));
  assert.ok(report.evidence.workflow.sources.some((source) => source.state === "unknown"));
});

test("a carried encrypted Workflow patch removal flags both data and Workflow safety", () => {
  const base = pins();
  const candidate = structuredClone(base);
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: base, candidatePins: candidate,
    localChangedPaths: ["patches/0004-workflow.patch"],
    basePatchManifest: patchManifest,
    patchContents: { "0004-workflow.patch": { base: "+workflowStep encrypted\n+schema migration", candidate: undefined } },
  });
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, true);
});

test("a pin rollback reports the exact previous candidate and its reverse migration impact", () => {
  const previous = pins();
  const newer = structuredClone(previous);
  newer.home = artifact("home", "v1.1.7", sha("d"), "3");
  const report = classifySnapshots({
    baseGitCommit: sha("2"), candidateGitCommit: sha("3"), basePins: newer, candidatePins: previous,
    homeComparison: { complete: true, files: [{ filename: "internal/cluster/schema_migration.go" }] },
  });
  assert.equal(report.base.pins.home.tag, "v1.1.7");
  assert.equal(report.candidate.pins.home.tag, "v1.1.6");
  assert.equal(report.databaseChanged, true);
});
