import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { canonical, digest } from "../release-barrier/manifest.ts";
import {
  readRecoveryManifest,
  readRecoveryProgress,
  recoveryReceipt,
} from "../release-barrier/recovery-manifest.ts";
import { SafetyGateError } from "./contracts.ts";
import { readDeploymentLedger, type LedgerEnvironment } from "./github-ledger.ts";
import { record, requestJson, withBearer, type Fetcher } from "./http.ts";
import { recoveryArtifact } from "./recovery-artifact.ts";

export interface RecordedRecoveryRequest {
  candidate: string;
  sourceRun: string;
  pairSha256: string;
  databaseCompatible: boolean;
  progressRun?: string;
}

export interface RecordedRecoveryIo {
  environment: LedgerEnvironment;
  directory: string;
  fetcher: Fetcher;
  prepare(candidate: string): Promise<string>;
  execute(root: string, args: string[], databaseCompatible: boolean): Promise<void>;
}

export async function runRecordedRecovery(
  request: RecordedRecoveryRequest,
  io: RecordedRecoveryIo,
): Promise<void> {
  if (
    !/^[a-f0-9]{40}$/.test(request.candidate) ||
    !/^[a-f0-9]{64}$/.test(request.pairSha256) ||
    !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(request.sourceRun)
  )
    throw new SafetyGateError(
      "Recovery source needs an exact candidate, run/attempt and pair SHA-256",
    );
  const [run, attempt] = request.sourceRun.split("/").map(Number);
  if (![run, attempt].every(Number.isSafeInteger))
    throw new SafetyGateError("Recovery source run/attempt is invalid");
  const source = await assertSource(request, io, run!, attempt!);
  const artifact = await recoveryArtifact(
    io.environment,
    io.fetcher,
    run!,
    "release-barrier",
    join(io.directory, "source"),
    source.head_sha,
  );
  if (!artifact.files.has("manifest.json") || !artifact.files.has("receipt.json"))
    throw new SafetyGateError("Recovery is missing the recorded manifest or receipt");
  const manifest: unknown = JSON.parse(artifact.files.get("manifest.json")?.toString() ?? "null");
  const receipt: unknown = JSON.parse(artifact.files.get("receipt.json")?.toString() ?? "null");
  if (digest(canonical({ manifest, receipt })) !== request.pairSha256)
    throw new SafetyGateError(
      "Recovery manifest/receipt pair digest differs from the requested pair",
    );
  try {
    const frozen = readRecoveryManifest(manifest);
    const admitted = Schema.decodeUnknownSync(recoveryReceipt)(receipt);
    if (
      frozen.stack !== "basalt" ||
      frozen.stage !== "production" ||
      frozen.candidate !== request.candidate ||
      admitted.candidate !== request.candidate ||
      admitted.manifest !== digest(canonical(frozen))
    )
      throw new Error();
    if (
      "containers" in frozen &&
      (!request.databaseCompatible || !artifact.files.has("container-recovery.sealed.json"))
    )
      throw new SafetyGateError(
        "Recovery container needs its sealed descriptor and explicit database compatibility",
      );
  } catch (error) {
    if (error instanceof SafetyGateError) throw error;
    throw new SafetyGateError(
      "Recovery manifest/receipt contract differs from the recorded admitted candidate",
    );
  }
  const identity = {
    candidate: request.candidate,
    sourceRun: request.sourceRun,
    pairSha256: request.pairSha256,
    repository: io.environment.repository,
  };
  if (artifact.files.has("recovery.json") || artifact.files.has("source.json"))
    throw new SafetyGateError(
      "Recovery source contains implicit recovery progress; name its explicit progress run",
    );
  if (request.progressRun) {
    if (!/^[1-9][0-9]*\/[1-9][0-9]*$/.test(request.progressRun))
      throw new SafetyGateError("Recovery progress needs an exact run/attempt");
    const [progressRun, progressAttempt] = request.progressRun.split("/").map(Number);
    if (![progressRun, progressAttempt].every(Number.isSafeInteger))
      throw new SafetyGateError("Recovery progress run/attempt is invalid");
    const previousRun = await readRun(io, progressRun!, progressAttempt!, true);
    const previous = await recoveryArtifact(
      io.environment,
      io.fetcher,
      progressRun!,
      "recorded-version-recovery",
      join(io.directory, "progress"),
      previousRun.head_sha,
    );
    try {
      if (
        canonical(JSON.parse(previous.files.get("source.json")!.toString())) !==
          canonical(identity) ||
        [...artifact.files].some(([name, bytes]) => !previous.files.get(name)?.equals(bytes))
      )
        throw new Error();
      const bytes = previous.files.get("recovery.json")!;
      const progress = readRecoveryProgress(JSON.parse(bytes.toString()));
      if (
        progress.candidate !== request.candidate ||
        progress.manifest !== digest(canonical(manifest))
      )
        throw new Error();
      artifact.files.set("recovery.json", bytes);
    } catch {
      throw new SafetyGateError(
        "Recovery progress does not match the exact source release and manifest/receipt pair",
      );
    }
  }
  artifact.files.set("source.json", Buffer.from(JSON.stringify(identity, null, 2) + "\n"));
  mkdirSync(io.directory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of artifact.files)
    writeFileSync(join(io.directory, name), bytes, { mode: 0o600, flag: "wx" });
  const root = await io.prepare(request.candidate);
  const current = await assertSource(request, io, run!, attempt!);
  if (current.deploymentId !== source.deploymentId || current.head_sha !== source.head_sha)
    throw new SafetyGateError("Recovery source changed during candidate preparation");
  for (const [name, bytes] of artifact.files) {
    let currentBytes: Buffer;
    try {
      currentBytes = readFileSync(join(io.directory, name));
    } catch {
      throw new SafetyGateError(`Recovery evidence ${name} is missing after candidate preparation`);
    }
    if (!currentBytes.equals(bytes))
      throw new SafetyGateError(`Recovery evidence ${name} changed during candidate preparation`);
  }
  await io.execute(
    root,
    [
      "run",
      "deploy",
      "--",
      "--recover",
      join(io.directory, "manifest.json"),
      join(io.directory, "receipt.json"),
    ],
    request.databaseCompatible,
  );
}

async function assertSource(
  request: RecordedRecoveryRequest,
  io: RecordedRecoveryIo,
  run: number,
  attempt: number,
) {
  const ledger = await readDeploymentLedger(io.environment, io.fetcher);
  if (
    ledger.state !== "unresolved" ||
    !["failure", "error"].includes(ledger.deploymentStatus) ||
    ledger.gitCommit !== request.candidate ||
    ledger.payload?.kind !== "release" ||
    ledger.payload.candidateGitCommit !== request.candidate ||
    ledger.payload.run?.id !== run ||
    ledger.payload.run.attempt !== attempt ||
    ledger.payload.run.repository !== io.environment.repository ||
    !ledger.lastSuccessful ||
    ledger.lastSuccessful.gitCommit !== ledger.payload.baseGitCommit
  )
    throw new SafetyGateError(
      `Recovery source is not the latest failed production release ${request.candidate} from run ${run}/${attempt}`,
    );
  return { ...(await readRun(io, run, attempt)), deploymentId: ledger.deploymentId };
}

async function readRun(io: RecordedRecoveryIo, run: number, attempt: number, progress = false) {
  const source = record(
    (
      await requestJson(
        io.fetcher,
        "GitHub",
        `https://api.github.com/repos/${io.environment.repository}/actions/runs/${run}`,
        {
          headers: withBearer(io.environment.token),
        },
      )
    ).body,
    "recovery source run",
  );
  if (
    source.id !== run ||
    source.run_attempt !== attempt ||
    source.status !== "completed" ||
    !["failure", "cancelled", "timed_out", ...(progress ? ["success"] : [])].includes(
      String(source.conclusion),
    ) ||
    source.head_branch !== "main" ||
    !["push", "workflow_dispatch"].includes(String(source.event)) ||
    !(
      progress
        ? [".github/workflows/release-rollback.yml"]
        : [".github/workflows/release-main.yml", ".github/workflows/deploy.yml"]
    ).includes(String(source.path)) ||
    record(source.head_repository, "source repository").full_name !== io.environment.repository ||
    typeof source.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(source.head_sha)
  )
    throw new SafetyGateError(
      `Recovery source run ${run}/${attempt} is not a completed failed main production workflow`,
    );
  return { head_sha: source.head_sha };
}
