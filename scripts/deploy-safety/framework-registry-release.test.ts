import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  qualifiedFrameworkRegistry,
  renderQualifiedFrameworkRegistry,
} from "./framework-registry.ts";
import type { FrameworkReleaseProvenance } from "./framework-qualification.ts";
import { record } from "./http.ts";
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
  const controller = join(directory, "controller");
  const candidate = join(directory, "candidate");
  const write = (root: string, path: string, value: string) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  };
  for (const file of [
    "framework-registry-release.ts",
    "framework-registry.ts",
    "framework-qualification.ts",
    "framework-refusal.ts",
    "github-ledger.ts",
    "contracts.ts",
    "http.ts",
  ]) {
    const destination = join(controller, "scripts/deploy-safety", file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(file, import.meta.url), destination);
  }
  copyFileSync(
    new URL("../framework-artifacts.ts", import.meta.url),
    join(controller, "scripts/framework-artifacts.ts"),
  );
  write(controller, "package.json", '{"type":"module"}');
  write(candidate, "package.json", '{"type":"module"}');
  write(
    controller,
    "framework-release.ts",
    'export const servedFrameworkVersion = "wrong-controller-version"; export const servedFrameworkProtocol = 1;',
  );
  write(
    controller,
    "scripts/framework-provenance.ts",
    'throw new Error("Controller producer must not be imported");',
  );
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
  if (process.env.FIXTURE_CONTROLLER_SECRET !== undefined || process.env.GITHUB_TOKEN !== undefined)
    throw new Error("Controller credentials reached candidate evaluation");
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
  write(controller, ".fixture-history.json", "[]");
  write(
    controller,
    "run.mjs",
    `
import { readFileSync } from "node:fs";
import { releaseFrameworkQualification } from "./scripts/deploy-safety/framework-registry-release.ts";
let historyReads = 0;
let activated = false;
const fetcher = async (input, init) => {
  if (init?.method !== "GET" || !new URL(String(input)).pathname.endsWith("/deployments"))
    throw new Error("Unexpected production history request");
  historyReads++;
  return Response.json(JSON.parse(readFileSync(new URL("./.fixture-history.json", import.meta.url), "utf8")));
};
try {
  const qualification = await releaseFrameworkQualification(process.argv[2], process.argv[3], "fixture/repository", "synthetic-controller-token", fetcher);
  activated = true;
  process.stdout.write(JSON.stringify({ qualification, historyReads, activated }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : "unknown refusal", historyReads, activated }));
  process.exitCode = 1;
}
`,
  );
  const run = (candidateCommit = commit) => {
    const result = spawnSync(
      process.execPath,
      [join(controller, "run.mjs"), candidate, candidateCommit],
      {
        cwd: controller,
        env: {
          PATH: process.env.PATH,
          FIXTURE_CONTROLLER_SECRET: "synthetic-controller-secret",
          GITHUB_TOKEN: "synthetic-controller-token",
          BASALT_FRAMEWORK_HISTORY: join(controller, "must-not-be-used.json"),
          GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      assert.fail("Trusted controller did not return a JSON result");
    }
    return { status: result.status, result: record(value, "fixture controller result") };
  };
  return {
    controller,
    candidate,
    actual,
    canonical,
    canonicalPath,
    generatedPath,
    receipt,
    runtime,
    artifacts,
    write,
    run,
  };
}

test("unprepared trusted controller qualifies the separately prepared candidate's producer and canonical releases", (t) => {
  const value = fixture(t);
  assert.equal(existsSync(join(value.controller, ".upstream")), false);
  const outcome = value.run();
  assert.equal(outcome.status, 0);
  assert.deepEqual(outcome.result.qualification, value.receipt.qualification);
  assert.equal(outcome.result.historyReads, 1);
  assert.equal(outcome.result.activated, true);
  assert.equal(existsSync(join(value.controller, ".upstream")), false);
  const changedCanonical = [release("new-candidate-canonical-version", "3")];
  value.write(
    value.candidate,
    value.canonicalPath,
    `export const canonicalFrameworkReleases = ${JSON.stringify(changedCanonical)};`,
  );
  const changed = value.run();
  assert.equal(changed.status, 1);
  assert.equal(changed.result.activated, false);
  assert.match(String(changed.result.error), /new-candidate-canonical-version/);
});

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

test("changed publication bytes refuse before activation even when the producer identity stays the same", (t) => {
  const value = fixture(t);
  const frameworkPath = ".upstream/.local/basalt-framework/framework.json";
  value.write(
    value.candidate,
    frameworkPath,
    JSON.stringify({ "runtime.json": value.runtime, "index.d.ts": "changed declarations" }),
  );
  const changedPackage = value.run();
  assert.equal(changedPackage.status, 1);
  assert.equal(changedPackage.result.activated, false);
  assert.match(
    String(changedPackage.result.error),
    /qualification.artifacts.frameworkJsonSha256.*expected.*observed/,
  );
  value.write(
    value.candidate,
    frameworkPath,
    JSON.stringify({ "runtime.json": "changed runtime" }),
  );
  const splitRuntime = value.run();
  assert.equal(splitRuntime.status, 1);
  assert.equal(splitRuntime.result.activated, false);
  assert.match(String(splitRuntime.result.error), /runtime.json.sha256.*expected.*observed/);
  value.write(value.candidate, ".upstream/packages/apps/dist/runtime.json", "changed runtime");
  const changedRuntime = value.run();
  assert.equal(changedRuntime.status, 1);
  assert.equal(changedRuntime.result.activated, false);
  assert.match(
    String(changedRuntime.result.error),
    /artifacts.runtimeJsonSha256.*expected.*observed/,
  );
  rmSync(join(value.candidate, frameworkPath));
  const missing = value.run();
  assert.equal(missing.status, 1);
  assert.equal(missing.result.activated, false);
  assert.ok(String(missing.result.error).includes(frameworkPath));
});

test("a changed release candidate or its live producer constants refuses before activation", (t) => {
  const value = fixture(t);
  const anotherCommit = "3".repeat(40);
  const mismatched = value.run(anotherCommit);
  assert.equal(mismatched.status, 1);
  assert.equal(mismatched.result.activated, false);
  assert.match(String(mismatched.result.error), new RegExp(anotherCommit));
  assert.ok(String(mismatched.result.error).includes(value.candidate));
  assert.match(
    String(mismatched.result.error),
    /qualification.producerGitCommit.*expected.*observed/,
  );
  value.write(
    value.candidate,
    "framework-release.ts",
    'export const servedFrameworkVersion = "changed-candidate-version"; export const servedFrameworkProtocol = 44;',
  );
  const changed = value.run();
  assert.equal(changed.status, 1);
  assert.equal(changed.result.activated, false);
  assert.match(
    String(changed.result.error),
    /version.*expected "changed-candidate-version"; observed "candidate-version"/,
  );
});

test("missing artifacts and failed candidate evaluation name their paths without child output", (t) => {
  const value = fixture(t);
  rmSync(join(value.candidate, value.generatedPath));
  const missing = value.run();
  assert.equal(missing.status, 1);
  assert.equal(missing.result.activated, false);
  assert.ok(String(missing.result.error).includes(join(value.candidate, value.generatedPath)));
  assert.match(
    String(missing.result.error),
    /file: expected "readable UTF-8 artifact"; observed "unavailable"/,
  );
  value.write(
    value.candidate,
    "scripts/framework-provenance.ts",
    'process.stdout.write("synthetic-private-child-output"); throw new Error("synthetic-private-child-error");',
  );
  const failed = value.run();
  assert.equal(failed.status, 1);
  assert.equal(failed.result.activated, false);
  assert.ok(
    String(failed.result.error).includes(join(value.candidate, "scripts/framework-provenance.ts")),
  );
  assert.match(String(failed.result.error), /producer.exitStatus: expected 0; observed 1/);
  assert.equal(String(failed.result.error).includes("synthetic-private-child"), false);
  assert.equal(String(failed.result.error).includes("synthetic-controller-token"), false);
});
