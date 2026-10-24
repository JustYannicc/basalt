import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedFailure, digest, pinProofSource } from "./zoho-tests/evidence.mjs";
import {
  loadZohoCatalogSource,
  localZohoOAuthDefinition,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_SNAPSHOT_PATH,
  ZOHO_SNAPSHOT_SHA256,
} from "./zoho-tests/catalog.mjs";

const BASE_COMMIT = "c74e117f06828297219974e8910066d1c0a3ab9a";
const PRODUCT_COMMIT = "432dbf6ff5c61872b8964354f0a71b3c7995d850";
const MERGED_PRODUCT_COMMIT = "c363d92cb98f910a8c0e4ee340e80106c386914b";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".upstream");
const heavySlot = join(homedir(), ".local/bin/heavy-slot");
const evidenceRoot = join(dirname(ZOHO_SNAPSHOT_PATH), "zoho-native-proof");
const git = (args: string[]) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

async function writeJsonExclusive(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

async function requirePreparedE2E(upstreamRoot: string) {
  for (const path of ["host.json", "apps.tgz", "npm"]) {
    await access(join(upstreamRoot, ".local/test-runtime", path)).catch(() => {
      throw new Error(
        "Prepared .upstream E2E runtime is missing " + path
          + "; run heavy-slot bun run e2e:prepare from the prepared .upstream checkout first.",
      );
    });
  }
}

async function pinAndPreflight() {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  const sourcePin = pinProofSource(root, candidateCommit, BASE_COMMIT);
  const productTree = git(["rev-parse", PRODUCT_COMMIT + "^{tree}"]);
  const mergedProductTree = git(["rev-parse", MERGED_PRODUCT_COMMIT + "^{tree}"]);
  assert.equal(productTree, mergedProductTree,
    "Merged PR23 product tree differs from the frozen Zoho branch product tree");
  const runtimeOAuth = await import(pathToFileURL(join(
    upstream,
    "apps/hosted/server/src/implementation/first-party-oauth.ts",
  )).href);
  const catalogApp = await loadZohoCatalogSource({
    upstream,
    providerOrigin: "http://127.0.0.1:49152",
    hostedDefinitions: runtimeOAuth.firstPartyOAuthClientDefinitions,
  });
  const localOAuth = localZohoOAuthDefinition(
    runtimeOAuth.firstPartyOAuthClientDefinitions,
    "http://127.0.0.1:49152",
  );
  await requirePreparedE2E(upstream);
  const require = createRequire(join(upstream, "package.json"));
  const browser = require("playwright").chromium.executablePath();
  await access(browser);
  return {
    candidateCommit,
    baseCommit: BASE_COMMIT,
    sourcePin,
    productCommit: PRODUCT_COMMIT,
    mergedProductCommit: MERGED_PRODUCT_COMMIT,
    productTree,
    mergedProductTree,
    snapshotSha256: catalogApp.snapshot.sha256,
    originalSnapshotFiles: catalogApp.snapshot.files,
    deploymentPayload: catalogApp.payload,
    sdkAdaptation: catalogApp.sdkAdaptation,
    loopbackOriginRewrites: catalogApp.loopbackOriginRewrites,
    localOAuthTestAdaptation: localOAuth.adaptation,
    browser,
  };
}

function childProcess(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const append = (current: string, chunk: Buffer) =>
        current.length >= 32_768 ? current : (current + chunk.toString()).slice(0, 32_768);
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, "SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, 15_000);
      }, 25 * 60_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, signal, timedOut, stdout, stderr });
      });
    },
  );
}

async function fileDigest(path: string) {
  const bytes = await readFile(path);
  return { path: path.split("/").at(-1), bytes: bytes.byteLength, sha256: digest(bytes) };
}

async function runProof(preflight: Awaited<ReturnType<typeof pinAndPreflight>>) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await chmod(evidenceRoot, 0o700);
  const directory = await mkdtemp(join(evidenceRoot, "run-"));
  await chmod(directory, 0o700);
  const home = join(directory, "home");
  const temporary = join(home, "tmp");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const proofPinPath = join(directory, "proof-pin.json");
  const proofPin = {
    schemaVersion: 1,
    candidateCommit: preflight.candidateCommit,
    baseCommit: preflight.baseCommit,
    sourcePin: preflight.sourcePin,
    snapshotPath: ZOHO_SNAPSHOT_PATH,
    snapshotSha256: ZOHO_SNAPSHOT_SHA256,
    productCommit: PRODUCT_COMMIT,
    mergedProductCommit: MERGED_PRODUCT_COMMIT,
    productTree: preflight.productTree,
    mergedProductTree: preflight.mergedProductTree,
  };
  await writeJsonExclusive(proofPinPath, proofPin);

  const childEnvironment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };
  const args = [
    "/usr/bin/env",
    "-i",
    ...Object.entries(childEnvironment).map(([key, value]) => key + "=" + value),
    "bun",
    join(root, "scripts/zoho-tests/runtime.mjs"),
    root,
    upstream,
    directory,
    preflight.browser,
    proofPinPath,
  ];
  const execution = await childProcess(heavySlot, args, upstream);
  const outcomePath = join(directory, "outcome.json");
  const failurePath = join(directory, "failure.json");
  const sourceMetadataPath = join(directory, "source-metadata.json");
  const invocationPath = join(directory, "invocation.json");
  const mcpInvocationPath = join(directory, "mcp-invocation.json");
  const requestsPath = join(directory, "provider-requests.json");
  const exists = async (path: string) => access(path).then(() => true, () => false);
  const outcome = await exists(outcomePath) ? JSON.parse(await readFile(outcomePath, "utf8")) : undefined;
  const failure = await exists(failurePath) ? JSON.parse(await readFile(failurePath, "utf8")) : undefined;
  const sourceMetadata = await exists(sourceMetadataPath) ? JSON.parse(await readFile(sourceMetadataPath, "utf8")) : undefined;
  const providerRequests = await exists(requestsPath) ? JSON.parse(await readFile(requestsPath, "utf8")) : undefined;
  const passed = execution.code === 0 && !execution.timedOut && outcome?.status === "passed";
  const record = {
    schemaVersion: 1,
    status: passed ? "passed" : "failed",
    recordedAt: new Date().toISOString(),
    candidateCommit: preflight.candidateCommit,
    baseCommit: preflight.baseCommit,
    sourcePin: preflight.sourcePin,
    mergedProduct: {
      productCommit: PRODUCT_COMMIT,
      mergedCommit: MERGED_PRODUCT_COMMIT,
      productTree: preflight.productTree,
      mergedProductTree: preflight.mergedProductTree,
      sameTree: preflight.productTree === preflight.mergedProductTree,
    },
    officialSnapshot: {
      path: ZOHO_SNAPSHOT_PATH,
      sha256: ZOHO_SNAPSHOT_SHA256,
      originalFiles: preflight.originalSnapshotFiles,
    },
    sourceMetadata,
    outcome,
    failure: failure ?? (passed ? null : boundedFailure(
      execution.timedOut ? "heavy-slot native invocation timeout" : "heavy-slot native invocation",
      new Error("Zoho runtime proof exited with code " + execution.code + " and signal " + execution.signal),
      [ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET],
    )),
    providerRequests,
    files: {
      proofPin: await fileDigest(proofPinPath),
      invocation: await exists(invocationPath) ? await fileDigest(invocationPath) : null,
      mcpInvocation: await exists(mcpInvocationPath) ? await fileDigest(mcpInvocationPath) : null,
      sourceMetadata: await exists(sourceMetadataPath) ? await fileDigest(sourceMetadataPath) : null,
      providerRequests: await exists(requestsPath) ? await fileDigest(requestsPath) : null,
      outcome: await exists(outcomePath) ? await fileDigest(outcomePath) : null,
      failure: await exists(failurePath) ? await fileDigest(failurePath) : null,
    },
    process: { heavySlot: true, exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut },
  };
  const recordPath = join(directory, "record.json");
  await writeJsonExclusive(recordPath, record);
  const recordHash = digest(await readFile(recordPath));
  const summary = {
    status: record.status,
    candidateCommit: preflight.candidateCommit,
    baseCommit: preflight.baseCommit,
    recordPath,
    recordSha256: recordHash,
    runtimeCommit: preflight.sourcePin.runtimeCommit,
    checks: outcome?.checks ?? null,
    missingLiveProof: ["Zoho production OAuth consent", "Zoho production CRM API response"],
  };
  console.log(JSON.stringify(summary));
  if (!passed) process.exitCode = 1;
}

const preflight = await pinAndPreflight();
if (process.argv.includes("--preflight")) {
  console.log(JSON.stringify({
    status: "preflight-passed",
    candidateCommit: preflight.candidateCommit,
    baseCommit: preflight.baseCommit,
    candidateTree: preflight.sourcePin.candidateTree,
    runtimeCommit: preflight.sourcePin.runtimeCommit,
    patchDigests: preflight.sourcePin.patches,
    productTree: preflight.productTree,
    mergedProductTree: preflight.mergedProductTree,
    snapshotSha256: preflight.snapshotSha256,
    snapshotFiles: preflight.originalSnapshotFiles,
    deploymentPayloadSha256: preflight.deploymentPayload.sha256,
    deploymentFiles: preflight.deploymentPayload.files,
    sdkAdaptation: preflight.sdkAdaptation,
    loopbackOriginRewrites: preflight.loopbackOriginRewrites,
    localOAuthTestAdaptation: preflight.localOAuthTestAdaptation,
  }));
} else {
  await runProof(preflight);
}
