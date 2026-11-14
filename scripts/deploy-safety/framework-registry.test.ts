import assert from "node:assert/strict";
import test from "node:test";
import { pins, sha, digest } from "../releases/fixtures.test-helpers.ts";
import type { ClassificationReport } from "../releases/types.ts";
import { SafetyGateError } from "./contracts.ts";
import type {
  FrameworkQualification,
  FrameworkReleaseProvenance,
} from "./framework-qualification.ts";
import {
  frameworkRegistryDigest,
  qualifiedFrameworkRegistry,
  renderQualifiedFrameworkRegistry,
  validateFrameworkBuildReceipt,
} from "./framework-registry.ts";
import { deploymentPayloadFor, readQualifiedFrameworkHistory } from "./github-ledger.ts";
import type { Fetcher } from "./http.ts";

const release = (digit: string): FrameworkReleaseProvenance => ({
  version: `release-${digit}`,
  sha256: digest(digit),
  protocol: 44,
  browserSha256: digest("a"),
  source: { origin: "basalt", revision: `source-${digit}`, sha256: digest("b") },
});
const canonical = release("0");
const first = release("1");
const second = release("2");
const firstReceipt = qualifiedFrameworkRegistry([canonical], [], first, sha("1"));
const secondReceipt = qualifiedFrameworkRegistry(
  [canonical],
  [firstReceipt.qualification],
  second,
  sha("2"),
);

test("successive framework registries preserve canonical and earlier release identities", () => {
  const next = qualifiedFrameworkRegistry(
    [canonical],
    [firstReceipt.qualification, secondReceipt.qualification],
    release("3"),
    sha("3"),
  );
  assert.deepEqual(next.releases, [canonical, first, second, release("3")]);
  const repeated = qualifiedFrameworkRegistry(
    [canonical, canonical],
    [
      firstReceipt.qualification,
      secondReceipt.qualification,
      firstReceipt.qualification,
      secondReceipt.qualification,
    ],
    second,
    sha("2"),
  );
  const shuffled = qualifiedFrameworkRegistry(
    [canonical],
    [secondReceipt.qualification, firstReceipt.qualification],
    second,
    sha("2"),
  );
  assert.deepEqual(repeated.releases, [canonical, first, second]);
  assert.deepEqual(shuffled, repeated);
  assert.equal(shuffled.qualification.registrySha256, secondReceipt.qualification.registrySha256);
});

test("byte-identical publication reuses its original source binding after a source-only revision", () => {
  const produced = {
    ...first,
    source: { ...first.source, revision: "later source-only revision" },
  };
  const receipt = qualifiedFrameworkRegistry(
    [canonical],
    [firstReceipt.qualification],
    produced,
    sha("4"),
  );
  assert.deepEqual(receipt.produced, produced);
  assert.deepEqual(receipt.qualification.provenance, first);
  assert.deepEqual(receipt.releases, [canonical, first]);
  assert.equal(receipt.qualification.registrySha256, firstReceipt.qualification.registrySha256);
  assert.deepEqual(
    validateFrameworkBuildReceipt(
      receipt,
      sha("4"),
      produced,
      [canonical],
      [firstReceipt.qualification],
      renderQualifiedFrameworkRegistry(receipt.releases),
    ),
    receipt.qualification,
  );
});

test("one version and server identity cannot acquire different browser, protocol or package bytes", () => {
  const conflicts = [
    { ...first, browserSha256: digest("c") },
    { ...first, protocol: first.protocol + 1 },
    { ...first, source: { ...first.source, sha256: digest("d") } },
  ];
  for (const conflict of conflicts) {
    assert.throws(
      () => qualifiedFrameworkRegistry([first], [], conflict, sha("2")),
      /Produced framework conflicts with qualified/,
    );
    const conflictingHistory = { ...firstReceipt.qualification, provenance: conflict };
    assert.throws(
      () => qualifiedFrameworkRegistry([first], [conflictingHistory], second, sha("2")),
      /Conflicting qualified framework/,
    );
  }
  const conflictingSource = {
    ...firstReceipt.qualification,
    provenance: { ...first, source: { ...first.source, revision: "conflicting saved source" } },
  };
  assert.throws(
    () => qualifiedFrameworkRegistry([first], [conflictingSource], second, sha("2")),
    /Conflicting qualified framework/,
  );
  const anotherServer = { ...second, version: first.version };
  assert.deepEqual(qualifiedFrameworkRegistry([first], [], anotherServer, sha("2")).releases, [
    first,
    anotherServer,
  ]);
});

test("activation validates the checked candidate, producer, complete history and generated source", () => {
  const history = [firstReceipt.qualification];
  const generated = renderQualifiedFrameworkRegistry(secondReceipt.releases);
  const validate = (
    value: unknown = secondReceipt,
    candidate = sha("2"),
    produced = second,
    qualifications: FrameworkQualification[] = history,
    source = generated,
  ) =>
    validateFrameworkBuildReceipt(value, candidate, produced, [canonical], qualifications, source);
  assert.deepEqual(validate(), secondReceipt.qualification);
  const attempts: [string, () => unknown][] = [
    ["candidate changed", () => validate(secondReceipt, sha("3"))],
    [
      "producer bytes changed",
      () => validate(secondReceipt, sha("2"), { ...second, sha256: digest("3") }),
    ],
    [
      "producer source changed",
      () =>
        validate(secondReceipt, sha("2"), {
          ...second,
          source: { ...second.source, revision: "changed producer" },
        }),
    ],
    [
      "receipt producer changed",
      () =>
        validate({
          ...secondReceipt,
          qualification: { ...secondReceipt.qualification, producerGitCommit: sha("3") },
        }),
    ],
    ["history lost an earlier qualification", () => validate(secondReceipt, sha("2"), second, [])],
    [
      "history gained a qualification",
      () =>
        validate(secondReceipt, sha("2"), second, [
          ...history,
          { ...firstReceipt.qualification, provenance: release("3") },
        ]),
    ],
    [
      "digest changed",
      () =>
        validate({
          ...secondReceipt,
          qualification: { ...secondReceipt.qualification, registrySha256: digest("f") },
        }),
    ],
    [
      "generated source changed",
      () => validate(secondReceipt, sha("2"), second, history, generated + "\n"),
    ],
    ["receipt absent", () => validate(null)],
  ];
  for (const [reason, attempt] of attempts) assert.throws(attempt, SafetyGateError, reason);
  const removed = [canonical, second];
  assert.throws(
    () =>
      validate(
        {
          ...secondReceipt,
          releases: removed,
          qualification: {
            ...secondReceipt.qualification,
            registrySha256: frameworkRegistryDigest(removed),
          },
        },
        sha("2"),
        second,
        history,
        renderQualifiedFrameworkRegistry(removed),
      ),
    SafetyGateError,
    "A consistent replacement digest and generated file cannot hide lost qualified history",
  );
});

test("next release registry retains failed and status-less qualifications read from the ledger", async () => {
  const releasePins = pins();
  const report = (candidate: string): ClassificationReport => ({
    schemaVersion: 1,
    base: { gitCommit: sha("0"), pins: releasePins },
    candidate: { gitCommit: candidate, pins: releasePins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: {
      database: { state: "unchanged", sources: [] },
      workflow: { state: "unchanged", sources: [] },
    },
  });
  const rows = [firstReceipt.qualification, secondReceipt.qualification].map(
    (qualification, index) => ({
      id: index + 1,
      sha: qualification.producerGitCommit,
      environment: "production",
      payload: deploymentPayloadFor(
        report(qualification.producerGitCommit),
        "release",
        undefined,
        qualification,
      ),
      created_at: `2026-11-14T00:0${index}:00Z`,
    }),
  );
  const statuses = new Map<number, string[]>([
    [1, ["failure"]],
    [2, []],
  ]);
  let statusReads = 0;
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/deployments")) return Response.json(rows);
    statusReads++;
    const match = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    assert.ok(match);
    return Response.json((statuses.get(Number(match[1])) ?? []).map((state) => ({ id: 1, state })));
  };
  const environment = { repository: "owner/repo" };
  const history = await readQualifiedFrameworkHistory(environment, fetcher);
  const next = qualifiedFrameworkRegistry([canonical], history, release("3"), sha("3"));
  assert.deepEqual(next.releases, [canonical, first, second, release("3")]);
  rows.push({
    id: 3,
    sha: sha("3"),
    environment: "production",
    payload: deploymentPayloadFor(report(sha("3")), "release", undefined, next.qualification),
    created_at: "2026-11-14T00:03:00Z",
  });
  statuses.set(3, ["success"]);
  const freshHistory = await readQualifiedFrameworkHistory(environment, fetcher);
  assert.deepEqual(
    qualifiedFrameworkRegistry([canonical], freshHistory, release("3"), sha("3")),
    next,
  );
  assert.equal(statusReads, 0);
});
