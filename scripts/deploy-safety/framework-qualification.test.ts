import assert from "node:assert/strict";
import test from "node:test";
import { sha, digest } from "../releases/fixtures.test-helpers.ts";
import {
  parseFrameworkQualification,
  type FrameworkQualification,
} from "./framework-qualification.ts";

const qualification = (digit: string): FrameworkQualification => ({
  producerGitCommit: sha(digit),
  provenance: {
    version: `release ${digit} / custom label`,
    sha256: digest(digit),
    protocol: 44,
    browserSha256: digest("a"),
    source: { origin: "basalt", revision: "revision without a fixed prefix", sha256: digest("b") },
  },
  artifacts: { runtimeJsonSha256: digest("b"), frameworkJsonSha256: digest("d") },
  registrySha256: digest("c"),
});

test("release qualification requires both publication hashes and binds the runtime to its provenance", () => {
  const value = qualification("2");
  assert.deepEqual(parseFrameworkQualification(value).artifacts, value.artifacts);
  for (const artifacts of [
    undefined,
    { runtimeJsonSha256: digest("b") },
    { ...value.artifacts, frameworkJsonSha256: "not a hash" },
    { ...value.artifacts, runtimeJsonSha256: digest("e") },
  ])
    assert.throws(
      () => parseFrameworkQualification({ ...value, artifacts }),
      /frameworkQualification.artifacts/,
    );
});
