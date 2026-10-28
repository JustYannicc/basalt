import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport } from "../releases/types.ts";
import { assertWorkflowsDrained, inspectWorkflowChange } from "./cloudflare.ts";
import { SafetyGateError } from "./contracts.ts";

const credentials = { accountId: "account-fixture", apiToken: "token-fixture" };
const sha = (character: string) => character.repeat(40);

function workflowReport(): ClassificationReport {
  const pins = {
    tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: sha("a") },
    home: {
      repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
      tag: "v1",
      commit: sha("b"),
      binary: "home",
      assets: { amd64: { name: "amd64", sha256: "c".repeat(64) }, arm64: { name: "arm64", sha256: "d".repeat(64) } },
    },
    node: {
      repository: "https://github.com/router-for-me/CLIProxyAPI.git",
      tag: "v1",
      commit: sha("e"),
      binary: "node",
      assets: { amd64: { name: "amd64", sha256: "f".repeat(64) }, arm64: { name: "arm64", sha256: "0".repeat(64) } },
    },
  };
  return {
    schemaVersion: 1,
    base: { gitCommit: sha("1"), pins },
    candidate: { gitCommit: sha("2"), pins },
    databaseChanged: false,
    workflowChanged: true,
    evidence: {
      database: { state: "unchanged", sources: [] },
      workflow: { state: "changed", sources: [{ name: "fixture", state: "changed", base: sha("1"), candidate: sha("2"), changedPaths: ["apps/hosted/cloud/src/workflows.ts"] }] },
    },
  };
}

function cloudflareResponse(result: unknown, resultInfo: unknown) {
  return Response.json({ success: true, errors: [], result, result_info: resultInfo });
}

function mockFetch(instanceResults: unknown[][]) {
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    if (url.pathname.endsWith("/workflows"))
      return cloudflareResponse(
        [{ id: "workflow-id", name: "AppWorkflows" }],
        { page: 1, per_page: 100, total_count: 1, total_pages: 1, count: 1 },
      );
    if (url.pathname.endsWith("/instances")) {
      const cursor = url.searchParams.get("cursor");
      const index = cursor === "next" ? 1 : 0;
      const result = instanceResults[index] ?? [];
      const info = index === 0 && instanceResults.length > 1
        ? { count: result.length, per_page: Math.max(1, result.length), cursor: "next" }
        : { count: result.length, per_page: 100, cursor: null };
      return cloudflareResponse(result, info);
    }
    throw new Error(`Unexpected Cloudflare fixture URL ${url.pathname}`);
  };
  return { fetcher, requested };
}

test("workflow inspection reports manual quiescence even when the listing is empty", async () => {
  const fixture = mockFetch([[]]);
  const snapshot = await inspectWorkflowChange(workflowReport(), credentials, fixture.fetcher);
  assert.equal(snapshot.workflowCount, 1);
  assert.equal(snapshot.instanceCount, 0);
  assert.deepEqual(snapshot.unresolved, []);
  assert.equal(snapshot.manualQuiescenceRequired, true);
  assert.equal(fixture.requested.length, 2);
});

test("active instances are reported without termination and block the release", async () => {
  const fixture = mockFetch([[{ id: "run-1", status: "running" }]]);
  const snapshot = await inspectWorkflowChange(workflowReport(), credentials, fixture.fetcher);
  assert.deepEqual(snapshot.unresolved, [{ id: "run-1", workflowName: "AppWorkflows", status: "running" }]);
  assert.equal(snapshot.manualQuiescenceRequired, true);
  assert.equal(fixture.requested.length, 2);
  assert.throws(() => assertWorkflowsDrained(snapshot), /1 Workflow instance\(s\) are still queued, running, paused or waiting/);
});

test("a drained listing lets the release continue, and an errored instance does not block it", async () => {
  const fixture = mockFetch([[{ id: "run-1", status: "complete" }, { id: "run-2", status: "terminated" }, { id: "run-3", status: "errored" }]]);
  assertWorkflowsDrained(await inspectWorkflowChange(workflowReport(), credentials, fixture.fetcher));
});

test("repeated pagination cursor fails closed", async () => {
  let instancePage = 0;
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/workflows"))
      return cloudflareResponse([{ id: "workflow-id", name: "AppWorkflows" }], { page: 1, per_page: 100, total_count: 1, total_pages: 1, count: 1 });
    instancePage++;
    return cloudflareResponse([], { count: 0, per_page: 100, cursor: "same-cursor" });
  };
  await assert.rejects(inspectWorkflowChange(workflowReport(), credentials, fetcher), SafetyGateError);
  assert.equal(instancePage, 2);
});

test("unknown instance state fails closed", async () => {
  const fixture = mockFetch([[{ id: "run-1", status: "future-status" }]]);
  await assert.rejects(inspectWorkflowChange(workflowReport(), credentials, fixture.fetcher), /unknown Workflow instance status/);
});

test("waiting and unknown instances block the release", async () => {
  const fixture = mockFetch([[{ id: "run-1", status: "waiting" }, { id: "run-2", status: "unknown" }]]);
  const snapshot = await inspectWorkflowChange(workflowReport(), credentials, fixture.fetcher);
  assert.throws(() => assertWorkflowsDrained(snapshot), /2 Workflow instance\(s\)/);
});
