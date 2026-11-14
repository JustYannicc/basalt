import assert from "node:assert/strict";
import test from "node:test";
import { pins, sha, digest } from "../releases/fixtures.test-helpers.ts";
import type { ClassificationReport } from "../releases/types.ts";
import { SafetyGateError } from "./contracts.ts";
import {
  beginReleaseDeployment,
  deploymentPayloadFor,
  finishDeployment,
  readQualifiedFrameworkHistory,
} from "./github-ledger.ts";
import {
  parseFrameworkQualification,
  type FrameworkQualification,
} from "./framework-qualification.ts";
import { record, type Fetcher } from "./http.ts";

const environment = { repository: "owner/repo", token: "fixture-token" };
const releasePins = pins();
const report = (base: string, candidate: string): ClassificationReport => ({
  schemaVersion: 1,
  base: { gitCommit: base, pins: releasePins },
  candidate: { gitCommit: candidate, pins: releasePins },
  databaseChanged: false,
  workflowChanged: false,
  evidence: {
    database: { state: "unchanged", sources: [] },
    workflow: { state: "unchanged", sources: [] },
  },
});
const qualification = (digit: string): FrameworkQualification => ({
  producerGitCommit: sha(digit),
  provenance: {
    version: `release ${digit} / custom label`,
    sha256: digest(digit),
    protocol: 44,
    browserSha256: digest("a"),
    source: { origin: "basalt", revision: "revision without a fixed prefix", sha256: digest("b") },
  },
  registrySha256: digest("c"),
});

function github() {
  const deployments = [
    {
      id: 1,
      sha: sha("1"),
      environment: "production",
      payload: deploymentPayloadFor(report(sha("0"), sha("1"))) as unknown,
      created_at: "2026-11-14T00:00:00Z",
    },
  ];
  const statuses = new Map<number, string[]>([[1, ["success"]]]);
  const requests: { method: string; path: string; authorized: boolean }[] = [];
  const state = { dropQualificationReply: false };
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      authorized: new Headers(init?.headers).has("Authorization"),
    });
    if (url.pathname.endsWith("/deployments") && method === "GET")
      return Response.json(deployments);
    if (url.pathname.endsWith("/deployments") && method === "POST") {
      const body = record(JSON.parse(String(init?.body)), "fixture deployment request");
      const id = deployments.length + 1;
      const deployment = {
        id,
        sha: String(body.ref),
        environment: "production",
        payload: body.payload,
        created_at: `2026-11-14T00:${String(id).padStart(2, "0")}:00Z`,
      };
      deployments.unshift(deployment);
      const payload = { ...record(body.payload, "fixture deployment payload") };
      if (state.dropQualificationReply) delete payload.frameworkQualification;
      return Response.json({ ...deployment, payload }, { status: 201 });
    }
    const match = /\/deployments\/(\d+)(\/statuses)?$/.exec(url.pathname);
    assert.ok(match, `Unexpected fixture request ${method} ${url.pathname}`);
    const id = Number(match[1]);
    if (match[2] && method === "GET")
      return Response.json(
        (statuses.get(id) ?? []).map((value, index) => ({
          id: id * 100 + (statuses.get(id)?.length ?? 0) - index,
          state: value,
          created_at: "2026-11-14T01:00:00Z",
        })),
      );
    if (match[2] && method === "POST") {
      const body = record(JSON.parse(String(init?.body)), "fixture status request");
      statuses.set(id, [String(body.state), ...(statuses.get(id) ?? [])]);
      return Response.json({ id: id * 100, state: body.state }, { status: 201 });
    }
    assert.equal(method, "GET");
    return Response.json(deployments.find((deployment) => deployment.id === id));
  };
  return { fetcher, deployments, statuses, requests, state };
}

test("release qualifications remain after failed and missing activation statuses without status reads", async () => {
  const api = github();
  const first = qualification("2");
  const second = qualification("3");
  const firstId = await beginReleaseDeployment(
    report(sha("1"), sha("2")),
    environment,
    api.fetcher,
    undefined,
    undefined,
    first,
  );
  await finishDeployment(firstId, "failure", environment, api.fetcher);
  const secondId = await beginReleaseDeployment(
    report(sha("1"), sha("3")),
    environment,
    api.fetcher,
    undefined,
    { candidateGitCommit: sha("3"), contains: () => true },
    second,
  );
  api.statuses.delete(secondId);
  api.requests.length = 0;
  const history = await readQualifiedFrameworkHistory(
    { repository: environment.repository },
    api.fetcher,
  );
  assert.deepEqual(history, [second, first]);
  assert.equal(
    api.requests.some((request) => request.path.endsWith("/statuses")),
    false,
  );
  assert.equal(
    api.requests.some((request) => request.method !== "GET" || request.authorized),
    false,
  );
});

test("qualified history refuses malformed provenance and deployment identity drift with the deployment ID", async () => {
  const api = github();
  const value = qualification("2");
  const id = await beginReleaseDeployment(
    report(sha("1"), sha("2")),
    environment,
    api.fetcher,
    undefined,
    undefined,
    value,
  );
  const deployment = api.deployments.find((entry) => entry.id === id)!;
  const original = { ...deployment };
  const payload = record(original.payload, "fixture payload");
  const faults = [
    { payload: { ...payload, frameworkQualification: null } },
    { payload: { ...payload, frameworkQualification: { ...value, producerGitCommit: sha("3") } } },
    {
      payload: {
        ...payload,
        frameworkQualification: {
          ...value,
          provenance: { ...value.provenance, sha256: "private-payload-body" },
        },
      },
    },
    { payload: { ...payload, frameworkQualification: { ...value, registrySha256: digest("A") } } },
    {
      payload: {
        ...payload,
        frameworkQualification: { ...value, provenance: { ...value.provenance, protocol: 0 } },
      },
    },
    {
      payload: {
        ...payload,
        frameworkQualification: { ...value, provenance: { ...value.provenance, version: "" } },
      },
    },
    {
      payload: {
        ...payload,
        frameworkQualification: {
          ...value,
          provenance: { ...value.provenance, source: { ...value.provenance.source, revision: "" } },
        },
      },
    },
    {
      payload: {
        ...payload,
        frameworkQualification: {
          ...value,
          provenance: {
            ...value.provenance,
            source: { ...value.provenance.source, origin: "other" },
          },
        },
      },
    },
    { payload: { ...payload, kind: "rollback" } },
    { sha: sha("3") },
    { environment: "staging" },
  ];
  for (const fault of faults) {
    Object.assign(deployment, original, fault);
    await assert.rejects(
      readQualifiedFrameworkHistory(environment, api.fetcher),
      (error: unknown) => {
        assert.ok(error instanceof SafetyGateError);
        assert.match(error.message, new RegExp(`deployment ${id}:.*frameworkQualification`));
        assert.equal(error.message.includes("private-payload-body"), false);
        return true;
      },
    );
  }
});

test("release creation rejects qualification loss on API round trip and a different producer before enrollment", async () => {
  const api = github();
  const value = report(sha("1"), sha("2"));
  await assert.rejects(
    beginReleaseDeployment(
      value,
      environment,
      api.fetcher,
      undefined,
      undefined,
      qualification("3"),
    ),
    /frameworkQualification.producerGitCommit differs from deployment gitCommit/,
  );
  assert.equal(
    api.requests.some((request) => request.method === "POST"),
    false,
  );
  api.state.dropQualificationReply = true;
  await assert.rejects(
    beginReleaseDeployment(
      value,
      environment,
      api.fetcher,
      undefined,
      undefined,
      qualification("2"),
    ),
    /metadata did not round-trip/,
  );
  assert.equal(
    api.requests.some((request) => request.method === "POST" && request.path.endsWith("/statuses")),
    false,
  );
  assert.deepEqual(await readQualifiedFrameworkHistory(environment, api.fetcher), [
    qualification("2"),
  ]);
  assert.throws(
    () => deploymentPayloadFor(value, "rollback", undefined, qualification("1")),
    /Rollback deployment cannot record/,
  );
  assert.deepEqual(
    parseFrameworkQualification({ ...qualification("2"), producerGitCommit: sha("A") })
      .producerGitCommit,
    sha("a"),
  );
});
