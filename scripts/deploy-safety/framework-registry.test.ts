import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sha, digest } from "../releases/fixtures.test-helpers.ts";
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

const release = (digit: string): FrameworkReleaseProvenance => ({
  version: `release-${digit}`,
  sha256: digest(digit),
  protocol: 44,
  browserSha256: digest("a"),
  source: { origin: "basalt", revision: `source-${digit}`, sha256: digest("b") },
});
const artifacts = { runtimeJsonSha256: digest("b"), frameworkJsonSha256: digest("d") };
const canonical = release("0");
const first = release("1");
const second = release("2");
const firstReceipt = qualifiedFrameworkRegistry([canonical], [], first, sha("1"), artifacts);
const secondReceipt = qualifiedFrameworkRegistry(
  [canonical],
  [firstReceipt.qualification],
  second,
  sha("2"),
  artifacts,
);

test("generated registry decodes every publication byte without changing order or identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framework-registry-roundtrip-"));
  try {
    const registries = [
      [],
      [canonical],
      secondReceipt.releases,
      [{ ...first, version: "another-release" }, second],
    ];
    for (const [index, releases] of registries.entries()) {
      const path = join(directory, `registry-${index}.ts`);
      await writeFile(path, renderQualifiedFrameworkRegistry(releases));
      const generated = await import(pathToFileURL(path).href);
      assert.deepEqual(generated.generatedFrameworkReleases, releases);
      assert.equal(
        frameworkRegistryDigest(generated.generatedFrameworkReleases),
        frameworkRegistryDigest(releases),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successive framework registries preserve canonical and earlier release identities", () => {
  const next = qualifiedFrameworkRegistry(
    [canonical],
    [firstReceipt.qualification, secondReceipt.qualification],
    release("3"),
    sha("3"),
    artifacts,
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
    artifacts,
  );
  const shuffled = qualifiedFrameworkRegistry(
    [canonical],
    [secondReceipt.qualification, firstReceipt.qualification],
    second,
    sha("2"),
    artifacts,
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
    artifacts,
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
      artifacts,
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
      () => qualifiedFrameworkRegistry([first], [], conflict, sha("2"), artifacts),
      /Produced framework conflicts with qualified/,
    );
    const conflictingHistory = {
      ...firstReceipt.qualification,
      provenance: conflict,
      artifacts: { ...artifacts, runtimeJsonSha256: conflict.source.sha256 },
    };
    assert.throws(
      () => qualifiedFrameworkRegistry([first], [conflictingHistory], second, sha("2"), artifacts),
      /Conflicting qualified framework/,
    );
  }
  const conflictingSource = {
    ...firstReceipt.qualification,
    provenance: { ...first, source: { ...first.source, revision: "conflicting saved source" } },
  };
  assert.throws(
    () => qualifiedFrameworkRegistry([first], [conflictingSource], second, sha("2"), artifacts),
    /Conflicting qualified framework/,
  );
  const anotherServer = { ...second, version: first.version };
  assert.deepEqual(
    qualifiedFrameworkRegistry([first], [], anotherServer, sha("2"), artifacts).releases,
    [first, anotherServer],
  );
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
    validateFrameworkBuildReceipt(
      value,
      candidate,
      produced,
      [canonical],
      qualifications,
      source,
      artifacts,
    );
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
