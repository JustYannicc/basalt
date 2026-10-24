import assert from "node:assert/strict";
import { test } from "node:test";
import { runReleaseMergeGate, type WorkflowRunTrigger } from "./gate.ts";
import type { MergeGateApi, Review, WorkflowRun } from "./github.ts";
import { RELEASE_MERGE_POLICY, type ChangedFile, type PullRequestSnapshot, type ReleasePins } from "./policy.ts";
import { validateManualCandidate } from "./manual-candidate.ts";
import { latestChangeRequests, latestRunForPullRequest } from "./proofs.ts";

const repository = "owner/repo";
const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);
const nextMainSha = "d".repeat(40);
const branch = "release-updates/tools-v1.2.3";
const pins: ReleasePins = {
  tools: { repository: "UsefulSoftwareCo/executor", commit: "1".repeat(40) },
  home: artifact("CLIProxyAPIHome", "2"),
  node: artifact("CLIProxyAPI", "3"),
};
const nextPins: ReleasePins = { ...pins, tools: { ...pins.tools, commit: "4".repeat(40) } };
const baseUpstream = JSON.stringify(pins.tools);
const headUpstream = JSON.stringify(nextPins.tools);
const pool = JSON.stringify({ format_version: 1, artifacts: { home: pins.home, node: pins.node } });

function artifact(binary: string, commit: string) {
  return {
    repository: "UsefulSoftwareCo/CLIProxyAPI",
    tag: "v1.2.3",
    commit: commit.repeat(40),
    binary,
    assets: {
      amd64: { name: `${binary}_linux_amd64.tar.gz`, sha256: "a".repeat(64) },
      arm64: { name: `${binary}_linux_arm64.tar.gz`, sha256: "b".repeat(64) },
    },
  };
}

function pr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 19,
    state: "open",
    head: { sha: headSha, ref: branch, repo: { full_name: repository } },
    base: { ref: "main", sha: mainSha, repo: { full_name: repository } },
    labels: [{ name: RELEASE_MERGE_POLICY.releaseLabel }],
    ...overrides,
  };
}

function association(head = headSha, base = mainSha) {
  return {
    number: 19,
    head: { ref: branch, sha: head, repo: { full_name: repository } },
    base: { ref: "main", sha: base, repo: { full_name: repository } },
  };
}

function run(id: number, name: string, workflowNumber: number, conclusion = "success", head = headSha, base = mainSha): WorkflowRun {
  return {
    id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion,
    head_sha: head,
    head_branch: branch,
    run_number: workflowNumber,
    run_attempt: 1,
    created_at: `2026-10-24T00:00:${String(workflowNumber).padStart(2, "0")}Z`,
    pull_requests: [association(head, base)],
  };
}

function trigger(name: string = RELEASE_MERGE_POLICY.workflows.ci, id = 10, head = headSha, base = mainSha): WorkflowRunTrigger {
  return {
    runId: id,
    workflowName: name,
    event: "pull_request",
    conclusion: "success",
    headSha: head,
    headBranch: branch,
    repositoryFullName: repository,
    headRepositoryFullName: repository,
    pullRequests: [{
      number: 19,
      head: { sha: head, ref: branch, repositoryFullName: repository },
      base: { ref: "main", sha: base, repositoryFullName: repository },
    }],
  };
}

function previewReceipt(base = mainSha, head = headSha) {
  return { version: 1, pullRequest: 19, head, base, smoke: true, teardown: true };
}

function checkReceipt(base = mainSha, head = headSha) {
  return {
    version: 1,
    repository,
    pullRequest: 19,
    runId: 10,
    runAttempt: 1,
    head,
    base,
    mergeCommit: "e".repeat(40),
    parents: [base, head],
  };
}

function classificationReport(input: { database?: "unchanged" | "changed" | "unknown"; workflow?: "unchanged" | "changed" | "unknown"; base?: string; candidate?: string } = {}) {
  const database = input.database ?? "unchanged";
  const workflow = input.workflow ?? "unchanged";
  const evidence = (state: "unchanged" | "changed" | "unknown", path: string) => ({
    state,
    sources: [{ name: "source", state, base: "1".repeat(40), candidate: "2".repeat(40), changedPaths: state === "unchanged" ? [] : [path] }],
  });
  return {
    schemaVersion: 1,
    base: { gitCommit: input.base ?? mainSha, pins },
    candidate: { gitCommit: input.candidate ?? headSha, pins: nextPins },
    databaseChanged: database !== "unchanged",
    workflowChanged: workflow !== "unchanged",
    evidence: {
      database: evidence(database, "src/pool/database.ts"),
      workflow: evidence(workflow, "apps/hosted/workflow.ts"),
    },
  };
}

class FakeApi implements MergeGateApi {
  pr = pr();
  main = mainSha;
  ancestryBase = mainSha;
  files: ChangedFile[] = [
    { filename: "upstream.json", status: "modified", additions: 1, deletions: 1, changes: 2 },
    { filename: "scripts/releases/receipts/tools.json", status: "added", additions: 1, deletions: 0, changes: 1 },
  ];
  ciRuns = [run(10, RELEASE_MERGE_POLICY.workflows.ci, 1)];
  previewRuns = [run(20, RELEASE_MERGE_POLICY.workflows.preview, 1)];
  classification = classificationReport();
  unresolvedThreads = 0;
  reviews: Review[] = [];
  checkReceipt: unknown | undefined = checkReceipt();
  receipt: unknown | undefined = previewReceipt();
  addedLabels: string[] = [];
  branchUpdateCalls: Array<{ number: number; expectedHeadSha: string }> = [];
  mergeCalls: Array<{ number: number; sha: string }> = [];
  afterSecondReceipt?: () => void;
  private receiptCalls = 0;

  async getPullRequest(): Promise<PullRequestSnapshot> { return structuredClone(this.pr); }
  async getBranchSha(): Promise<string> { return this.main; }
  async compareAncestry(_repository: string, base: string): Promise<{ status: string; mergeBaseSha: string }> {
    return { status: base === this.ancestryBase ? "ahead" : "behind", mergeBaseSha: this.ancestryBase };
  }
  async listPullRequestFiles(): Promise<ChangedFile[]> { return structuredClone(this.files); }
  async getFileAt(_repository: string, path: string, ref: string): Promise<string | undefined> {
    if (path === "upstream.json") return ref === mainSha || ref === nextMainSha ? baseUpstream : headUpstream;
    if (path === "containers/pool/releases.json") return pool;
    if (path === "scripts/releases/receipts/tools.json" && ref !== mainSha && ref !== nextMainSha)
      return JSON.stringify({ schemaVersion: 1, source: "tools", releaseKey: "tools-v1.2.3", basePins: pins, candidatePins: nextPins, removedPatches: [] });
    return undefined;
  }
  async classifyCandidate(): Promise<unknown> { return structuredClone(this.classification); }
  async getWorkflows(): Promise<Array<{ id: number; name: string; state: string }>> {
    return [
      { id: 1, name: RELEASE_MERGE_POLICY.workflows.ci, state: "active" },
      { id: 2, name: RELEASE_MERGE_POLICY.workflows.preview, state: "active" },
    ];
  }
  async listWorkflowRuns(_repository: string, workflowId: number): Promise<WorkflowRun[]> {
    return structuredClone(workflowId === 1 ? this.ciRuns : this.previewRuns);
  }
  async getUnresolvedReviewThreadCount(): Promise<number> { return this.unresolvedThreads; }
  async listReviews(): Promise<Review[]> { return structuredClone(this.reviews); }
  async getCheckReceipt(): Promise<unknown | undefined> { return structuredClone(this.checkReceipt); }
  async getPreviewReceipt(): Promise<unknown | undefined> {
    this.receiptCalls += 1;
    const value = structuredClone(this.receipt);
    if (this.receiptCalls === 2) this.afterSecondReceipt?.();
    return value;
  }
  async addPullRequestLabels(_repository: string, _number: number, labels: string[]): Promise<void> { this.addedLabels.push(...labels); }
  async updatePullRequestBranch(_repository: string, number: number, expectedHeadSha: string): Promise<"accepted"> {
    this.branchUpdateCalls.push({ number, expectedHeadSha });
    return "accepted";
  }
  async mergeSquash(_repository: string, number: number, expectedHeadSha: string): Promise<void> {
    this.mergeCalls.push({ number, sha: expectedHeadSha });
  }
}

const makeApi = () => {
  const api = new FakeApi();
  api.pr = pr();
  api.main = mainSha;
  api.ancestryBase = mainSha;
  return api;
};

test("merges only the exact current head with current-base CI and preview receipt", async () => {
  const api = makeApi();
  const result = await runReleaseMergeGate(api, repository, trigger());
  assert.equal(result.status, "merged");
  assert.deepEqual(api.mergeCalls, [{ number: 19, sha: headSha }]);
});

test("blocks database or workflow impacts, adds machine labels, and treats unknown as risk", async () => {
  const database = makeApi();
  database.classification = classificationReport({ database: "changed" });
  const databaseResult = await runReleaseMergeGate(database, repository, trigger());
  assert.equal(databaseResult.status, "skipped");
  assert.deepEqual(database.addedLabels.sort(), ["database-change", "manual-release"]);
  assert.equal(database.mergeCalls.length, 0);

  const workflow = makeApi();
  workflow.classification = classificationReport({ workflow: "changed" });
  const workflowResult = await runReleaseMergeGate(workflow, repository, trigger());
  assert.equal(workflowResult.status, "skipped");
  assert.deepEqual(workflow.addedLabels.sort(), ["manual-release", "workflow-identity-change"]);
  assert.equal(workflow.mergeCalls.length, 0);

  const unknown = makeApi();
  unknown.classification = classificationReport({ database: "unknown" });
  assert.equal((await runReleaseMergeGate(unknown, repository, trigger())).status, "skipped");
  assert.deepEqual(unknown.addedLabels.sort(), ["database-change", "manual-release"]);
});

test("rejects stale classifier SHAs and preserves a manual release hold on a safe result", async () => {
  const stale = makeApi();
  stale.classification = classificationReport({ base: nextMainSha });
  assert.equal((await runReleaseMergeGate(stale, repository, trigger())).status, "skipped");
  assert.equal(stale.mergeCalls.length, 0);

  const manual = makeApi();
  manual.pr.labels.push({ name: "manual-release" });
  const result = await runReleaseMergeGate(manual, repository, trigger());
  assert.equal(result.status, "skipped");
  assert.equal(manual.addedLabels.length, 0);
  assert.equal(manual.mergeCalls.length, 0);
});

test("manual candidate proof ignores risk classification and manual labels", async () => {
  const api = makeApi();
  api.classification = classificationReport({ database: "unknown", workflow: "changed" });
  api.pr.labels.push({ name: "manual-release" });
  const candidate = await validateManualCandidate(api, repository, 19);
  assert.deepEqual(candidate, { pullRequest: 19, head: headSha, base: mainSha, source: "tools" });
  assert.equal(api.mergeCalls.length, 0);
});

test("manual candidate validation requires the current exact Check receipt", async () => {
  const api = makeApi();
  api.checkReceipt = undefined;
  await assert.rejects(validateManualCandidate(api, repository, 19), /no merge-result receipt/);
});

test("manual candidate rejects a head or base changed after backup approval", async () => {
  const changedHead = makeApi();
  await assert.rejects(validateManualCandidate(changedHead, repository, 19, nextHeadSha, mainSha), /head changed/);

  const changedBase = makeApi();
  await assert.rejects(validateManualCandidate(changedBase, repository, 19, headSha, nextMainSha), /main changed/);
});

test("does not merge a stale head or a PR whose base is behind current main", async () => {
  const staleHead = makeApi();
  staleHead.pr = pr({ head: { ...staleHead.pr.head, sha: nextHeadSha } });
  assert.equal((await runReleaseMergeGate(staleHead, repository, trigger())).status, "skipped");
  assert.equal(staleHead.mergeCalls.length, 0);

  const staleBase = makeApi();
  staleBase.main = nextMainSha;
  assert.equal((await runReleaseMergeGate(staleBase, repository, trigger())).status, "skipped");
  assert.equal(staleBase.mergeCalls.length, 0);
});

test("requires latest CI and preview runs to be completed successfully", async () => {
  for (const conclusion of ["failure", "skipped"]) {
    const api = makeApi();
    api.ciRuns = [run(9, RELEASE_MERGE_POLICY.workflows.ci, 1, "success"), run(11, RELEASE_MERGE_POLICY.workflows.ci, 2, conclusion)];
    const result = await runReleaseMergeGate(api, repository, trigger());
    assert.equal(result.status, "skipped", `latest CI ${conclusion}`);
    assert.equal(api.mergeCalls.length, 0);
  }

  const previewFailed = makeApi();
  previewFailed.previewRuns = [run(21, RELEASE_MERGE_POLICY.workflows.preview, 2, "failure")];
  assert.equal((await runReleaseMergeGate(previewFailed, repository, trigger())).status, "skipped");
  assert.equal(previewFailed.mergeCalls.length, 0);

  const staleBase = makeApi();
  staleBase.ciRuns = [run(22, RELEASE_MERGE_POLICY.workflows.ci, 2, "success", headSha, nextMainSha)];
  assert.equal((await runReleaseMergeGate(staleBase, repository, trigger())).status, "skipped");
  assert.equal(staleBase.mergeCalls.length, 0);
});

test("rejects a missing or forged preview receipt", async () => {
  const absent = makeApi();
  absent.receipt = undefined;
  assert.equal((await runReleaseMergeGate(absent, repository, trigger())).status, "skipped");

  const forged = makeApi();
  forged.receipt = previewReceipt(mainSha, nextHeadSha);
  assert.equal((await runReleaseMergeGate(forged, repository, trigger())).status, "skipped");
  assert.equal(forged.mergeCalls.length, 0);
});

test("requires a Check receipt from the exact run and exact merge-result parents", async () => {
  const absent = makeApi();
  absent.checkReceipt = undefined;
  assert.equal((await runReleaseMergeGate(absent, repository, trigger())).status, "skipped");
  assert.equal(absent.mergeCalls.length, 0);

  const wrongParents = makeApi();
  wrongParents.checkReceipt = { ...checkReceipt(), parents: [nextMainSha, headSha] };
  assert.equal((await runReleaseMergeGate(wrongParents, repository, trigger())).status, "skipped");
  assert.equal(wrongParents.mergeCalls.length, 0);

  const wrongMergeCommit = makeApi();
  wrongMergeCommit.checkReceipt = { ...checkReceipt(), mergeCommit: headSha };
  assert.equal((await runReleaseMergeGate(wrongMergeCommit, repository, trigger())).status, "skipped");
  assert.equal(wrongMergeCommit.mergeCalls.length, 0);

  const wrongRun = makeApi();
  wrongRun.checkReceipt = { ...checkReceipt(), runId: 99 };
  assert.equal((await runReleaseMergeGate(wrongRun, repository, trigger())).status, "skipped");
  assert.equal(wrongRun.mergeCalls.length, 0);

  const wrongAttempt = makeApi();
  wrongAttempt.ciRuns[0]!.run_attempt = 2;
  assert.equal((await runReleaseMergeGate(wrongAttempt, repository, trigger())).status, "skipped");
  assert.equal(wrongAttempt.mergeCalls.length, 0);
});

test("blocks unresolved review threads and outstanding change requests", async () => {
  const thread = makeApi();
  thread.unresolvedThreads = 1;
  assert.equal((await runReleaseMergeGate(thread, repository, trigger())).status, "skipped");
  assert.equal(thread.mergeCalls.length, 0);

  const botReview = makeApi();
  botReview.reviews = [{ user: { login: "review-bot[bot]", type: "Bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-24T00:00:00Z" }];
  assert.equal((await runReleaseMergeGate(botReview, repository, trigger())).status, "skipped");
  assert.equal(botReview.mergeCalls.length, 0);

  assert.deepEqual(latestChangeRequests([
    { user: { login: "review-bot[bot]", type: "Bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-24T00:00:00Z" },
    { user: { login: "review-bot[bot]", type: "Bot" }, state: "APPROVED", submitted_at: "2026-10-24T00:01:00Z" },
  ]), []);
});

test("rejects forged branch names and touched workflow files", async () => {
  const branchApi = makeApi();
  branchApi.pr = pr({ head: { ...branchApi.pr.head, ref: "release-updates-evil" } });
  assert.equal((await runReleaseMergeGate(branchApi, repository, trigger())).status, "skipped");
  assert.equal(branchApi.mergeCalls.length, 0);

  const wrongKeyApi = makeApi();
  wrongKeyApi.pr = pr({ head: { ...wrongKeyApi.pr.head, ref: "release-updates/forged-release" } });
  assert.equal((await runReleaseMergeGate(wrongKeyApi, repository, trigger())).status, "skipped");
  assert.equal(wrongKeyApi.mergeCalls.length, 0);

  const fileApi = makeApi();
  fileApi.files.push({ filename: ".github/workflows/release-preview.yml", status: "modified", additions: 1, deletions: 1, changes: 2 });
  assert.equal((await runReleaseMergeGate(fileApi, repository, trigger())).status, "skipped");
  assert.equal(fileApi.mergeCalls.length, 0);
});

test("rejects workflow completion events that lose the PR head association", async () => {
  const api = makeApi();
  const nested = { ...trigger(RELEASE_MERGE_POLICY.workflows.preview), event: "workflow_run", headSha: mainSha };
  assert.equal((await runReleaseMergeGate(api, repository, nested)).status, "skipped");
  assert.equal(api.mergeCalls.length, 0);
});

test("rechecks the head and main before the expected-head merge write", async () => {
  const changedHead = makeApi();
  changedHead.afterSecondReceipt = () => { changedHead.pr.head.sha = nextHeadSha; };
  assert.equal((await runReleaseMergeGate(changedHead, repository, trigger())).status, "skipped");
  assert.equal(changedHead.mergeCalls.length, 0);

  const changedMain = makeApi();
  changedMain.afterSecondReceipt = () => {
    changedMain.main = nextMainSha;
    changedMain.pr.base.sha = nextMainSha;
  };
  assert.equal((await runReleaseMergeGate(changedMain, repository, trigger())).status, "skipped");
  assert.deepEqual(changedMain.branchUpdateCalls, [{ number: 19, expectedHeadSha: headSha }]);
  assert.equal(changedMain.mergeCalls.length, 0);
});

test("updates a stale same-repository release branch and waits for new proofs", async () => {
  const api = makeApi();
  api.main = nextMainSha;
  api.pr.base.sha = nextMainSha;

  const result = await runReleaseMergeGate(api, repository, trigger());
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /waiting for new Check and Release preview runs/);
  assert.deepEqual(api.branchUpdateCalls, [{ number: 19, expectedHeadSha: headSha }]);
  assert.equal(api.mergeCalls.length, 0);
});

test("does not refresh a stale fork or a branch outside the release allowlist", async () => {
  const fork = makeApi();
  fork.main = nextMainSha;
  fork.pr.base.sha = nextMainSha;
  fork.pr.head.repo = { full_name: "fork/repo" };
  assert.equal((await runReleaseMergeGate(fork, repository, trigger())).status, "skipped");
  assert.equal(fork.branchUpdateCalls.length, 0);
  assert.equal(fork.mergeCalls.length, 0);

  const unallowlisted = makeApi();
  unallowlisted.main = nextMainSha;
  unallowlisted.pr.base.sha = nextMainSha;
  unallowlisted.files.push({ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 1, changes: 2 });
  assert.equal((await runReleaseMergeGate(unallowlisted, repository, trigger())).status, "skipped");
  assert.equal(unallowlisted.branchUpdateCalls.length, 0);
  assert.equal(unallowlisted.mergeCalls.length, 0);
});

test("selects the latest run by run number and rejects proof from a stale base", () => {
  const current = pr();
  const latest = latestRunForPullRequest([
    run(10, "Check", 1, "success"),
    run(11, "Check", 2, "failure"),
    run(12, "Check", 3, "success", headSha, nextMainSha),
  ], current, repository);
  assert.equal(latest?.id, 12);
});

