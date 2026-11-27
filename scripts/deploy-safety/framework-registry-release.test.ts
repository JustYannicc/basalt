import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  qualifiedFrameworkRegistry,
  renderQualifiedFrameworkRegistry,
} from "./framework-registry.ts";
import type { FrameworkReleaseProvenance } from "./framework-qualification.ts";
import { readFrameworkArtifacts } from "../framework-artifacts.ts";
import { preparedFrameworkRegistrySource } from "../framework-registry-source.ts";

const commit = "2".repeat(40);
const release = (version: string, digit: string): FrameworkReleaseProvenance => ({
  version,
  sha256: digit.repeat(64),
  protocol: 44,
  browserSha256: "a".repeat(64),
  source: { origin: "basalt", revision: `source-${digit}`, sha256: "b".repeat(64) },
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "basalt-qualified-candidate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = join(directory, "candidate");
  const write = (root: string, path: string, value: string) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  };
  write(candidate, "package.json", '{"type":"module"}');
  write(
    candidate,
    "framework-release.ts",
    'export const servedFrameworkVersion = "candidate-version"; export const servedFrameworkProtocol = 44;',
  );
  const actual = release("candidate-version", "2");
  const runtime = JSON.stringify({ version: "candidate-version", server: {} });
  actual.source.sha256 = createHash("sha256").update(runtime).digest("hex");
  write(candidate, ".upstream/packages/apps/dist/runtime.json", runtime);
  write(
    candidate,
    ".upstream/.local/basalt-framework/framework.json",
    JSON.stringify({ "runtime.json": runtime }),
  );
  const artifacts = readFrameworkArtifacts(candidate);
  const canonical = [release("candidate-canonical-version", "1")];
  write(candidate, ".fixture-producer.json", JSON.stringify(actual));
  const canonicalPath = ".upstream/packages/sdk/src/implementation/basalt-framework-releases.ts";
  write(
    candidate,
    canonicalPath,
    `export const canonicalFrameworkReleases = ${JSON.stringify(canonical)};`,
  );
  write(
    candidate,
    "scripts/framework-provenance.ts",
    `
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { servedFrameworkVersion, servedFrameworkProtocol } from "../framework-release.ts";
export async function builtFrameworkEvidence(root) {
  if (realpathSync(root) !== realpathSync(fileURLToPath(new URL("../", import.meta.url))))
    throw new Error("Producer received another checkout");
  const evidence = JSON.parse(readFileSync(new URL("../.fixture-producer.json", import.meta.url), "utf8"));
  return { ...evidence, version: servedFrameworkVersion, protocol: servedFrameworkProtocol };
}
`,
  );
  const receipt = qualifiedFrameworkRegistry(canonical, [], actual, commit, artifacts);
  write(candidate, ".generated/framework-qualification.json", JSON.stringify(receipt));
  const generatedPath =
    ".upstream/packages/sdk/src/implementation/basalt-qualified-framework-releases.ts";
  write(candidate, generatedPath, renderQualifiedFrameworkRegistry(receipt.releases));
  return {
    candidate,
    actual,
    canonical,
    canonicalPath,
    generatedPath,
    receipt,
    runtime,
    artifacts,
    write,
  };
}

test("offline prepared source checks bind the generated registry to its candidate and publication", (t) => {
  const value = fixture(t);
  assert.equal(
    preparedFrameworkRegistrySource(value.candidate, commit),
    renderQualifiedFrameworkRegistry(value.receipt.releases),
  );
  assert.throws(
    () => preparedFrameworkRegistrySource(value.candidate, "3".repeat(40)),
    /producerGitCommit/,
  );
  value.write(
    value.candidate,
    value.canonicalPath,
    `export const canonicalFrameworkReleases = ${JSON.stringify([release("missing-canonical", "3")])};`,
  );
  assert.throws(
    () => preparedFrameworkRegistrySource(value.candidate, commit),
    /canonical entry.*expected.*observed/,
  );
  value.write(
    value.candidate,
    value.canonicalPath,
    `export const canonicalFrameworkReleases = ${JSON.stringify(value.canonical)};`,
  );
  value.write(
    value.candidate,
    ".upstream/.local/basalt-framework/framework.json",
    JSON.stringify({ "runtime.json": value.runtime, changed: "declaration" }),
  );
  assert.throws(
    () => preparedFrameworkRegistrySource(value.candidate, commit),
    /artifacts.frameworkJsonSha256.*expected.*observed/,
  );
});
