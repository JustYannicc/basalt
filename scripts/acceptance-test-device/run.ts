/**
 * Registers or revokes the test pool's device for the acceptance-test-device workflow. Before it
 * signs anything for the device, it asks the tools service itself, through the signed read-only
 * setup verify, which pool the acceptance-pool setup created, and ties that answer to the setup
 * apply's own run by the app's digest. Nothing it writes holds an id in clear: the device's ids
 * leave only sealed for the coordinator's recipient key, and every line names kinds, counts and
 * digests.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Exit, Schema } from "effect";
import {
  acceptanceTestDevice,
  registerAcceptanceTestDevice,
  revokeAcceptanceTestDevice,
  type AcceptanceTestDevice,
} from "../release/acceptance-test-device.ts";
import { AcceptanceDeviceRefused } from "../release/acceptance-device.ts";
import { recipientKey, sealArtifact } from "../production-ops/artifact.ts";
import { acceptanceOperation, type AcceptanceInput } from "../acceptance-pool/client.ts";
import { targetOf } from "../acceptance-pool/target.ts";

/** The digest the setup apply's run records for its pool app instead of the id. */
export const appDigestDomain = "basalt-acceptance-pool-app-v1";
export const appDigest = (app: string) =>
  createHash("sha256").update(`${appDigestDomain}\n${app}`).digest("hex");

/** Why a run refused, in closed words; never an id, a host or a message from elsewhere. */
export type TestDeviceRefusal =
  | "config"
  | "go_invalid"
  | "verify_failed"
  | "setup_not_applied"
  | "setup_unverified"
  | "pool_digest_missing"
  | "pool_digest_differs"
  | "setup_run_invalid"
  | "device_missing"
  | "registration_refused"
  | "revoke_refused"
  | "unsealed_left_registered";

export class TestDeviceRefused extends Error {
  readonly reason: TestDeviceRefusal;
  constructor(reason: TestDeviceRefusal) {
    super(`Test device run refused: ${reason}`);
    this.reason = reason;
  }
}
const refuse = (reason: TestDeviceRefusal) => new TestDeviceRefused(reason);

const Verified = Schema.Struct({
  action: Schema.Literal("verify"),
  kind: Schema.Literal("setup"),
  planSha256: Schema.String,
  completed: Schema.Boolean,
  receipt: Schema.Struct({
    migration: Schema.String,
    organization: Schema.String,
    status: Schema.String,
    app: Schema.NullOr(Schema.String),
  }),
  verification: Schema.Struct({
    ok: Schema.Boolean,
    checks: Schema.Record(Schema.String, Schema.Boolean),
  }),
});
const decodeVerified = Schema.decodeUnknownExit(Verified);

export interface TestDeviceRun {
  readonly action: "register" | "revoke";
  readonly go: string;
  readonly signingKey: string;
  /** The setup plan's checksum, which the setup receipt is kept under. */
  readonly setupPlanSha256: string;
  /** The setup apply's run id, and that run's `operation.json`, which records the app's digest. */
  readonly setupRun: string;
  readonly setupOperation: unknown;
  /** register: the coordinator's RSA recipient key, SPKI DER as base64. */
  readonly recipient?: string;
  /** revoke: the environment the test device's secret is read from. */
  readonly env?: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
}

export interface TestDeviceDeps {
  readonly verify: (input: AcceptanceInput) => Promise<Record<string, unknown>>;
  /** The repository's own record of a workflow run, by id. */
  readonly setupRun: (id: string) => Promise<unknown>;
  readonly register: typeof registerAcceptanceTestDevice;
  readonly revoke: typeof revokeAcceptanceTestDevice;
  readonly seal: typeof sealArtifact;
}

/** The run as the repository's API answers for it, with the job's own token. */
async function repositoryRun(id: string): Promise<unknown> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error("No repository token");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${id}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Run unavailable");
  return response.json();
}

const defaults: TestDeviceDeps = {
  verify: (input) => acceptanceOperation(input),
  setupRun: repositoryRun,
  register: (target) => registerAcceptanceTestDevice(target),
  revoke: (target) => revokeAcceptanceTestDevice(target),
  seal: sealArtifact,
};

/** The verification checks a registration needs, beside the rest all being true. */
const registerChecks = ["onePool", "twoAccounts", "membership"] as const;

/**
 * The setup apply's run is the acceptance-pool workflow's own, dispatched on main and finished,
 * and its record is that apply's: the digest it carries can then only be the one that setup made.
 */
async function setupRunRecord(run: TestDeviceRun, deps: TestDeviceDeps) {
  const record = await deps.setupRun(run.setupRun).catch(() => undefined);
  const fields =
    typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
  if (
    fields.path !== ".github/workflows/acceptance-pool.yml" ||
    fields.head_branch !== "main" ||
    fields.event !== "workflow_dispatch" ||
    fields.conclusion !== "success"
  )
    throw refuse("setup_run_invalid");
  const operation =
    typeof run.setupOperation === "object" && run.setupOperation !== null
      ? (run.setupOperation as Record<string, unknown>)
      : undefined;
  if (operation === undefined) throw refuse("pool_digest_missing");
  if (
    operation.action !== "apply" ||
    operation.kind !== "setup" ||
    (operation.planSha256 !== undefined && operation.planSha256 !== run.setupPlanSha256)
  )
    throw refuse("setup_run_invalid");
  return operation;
}

const goPattern = /^coordinator-20\d\d-[A-Za-z0-9-]{1,96}$/u;
const sealTarget = "acceptance-test-device";

/**
 * The setup's own record, from the tools service, tied to the setup apply's run by digest. A
 * registration also needs every verification check to pass; a revoke needs only the applied
 * receipt, so a setup that degraded never stops its device from being revoked.
 */
async function provenSetup(run: TestDeviceRun, deps: TestDeviceDeps) {
  const answer = await deps
    .verify({
      target: targetOf("production").origin,
      signingKey: run.signingKey,
      kind: "setup",
      action: "verify",
      request: "{}",
      recipient: "",
      planSha256: run.setupPlanSha256,
      go: "",
    })
    .catch(() => {
      throw refuse("verify_failed");
    });
  const verified = decodeVerified(answer);
  if (Exit.isFailure(verified) || verified.value.planSha256 !== run.setupPlanSha256)
    throw refuse("verify_failed");
  const { receipt, verification, completed } = verified.value;
  if (
    !completed ||
    receipt.migration !== "acceptance-pool-setup-v1" ||
    receipt.organization !== "acceptance" ||
    receipt.status !== "applied" ||
    receipt.app === null
  )
    throw refuse("setup_not_applied");
  const checks = Object.values(verification.checks);
  if (
    run.action === "register" &&
    (!verification.ok ||
      !checks.every(Boolean) ||
      !registerChecks.every((name) => verification.checks[name] === true))
  )
    throw refuse("setup_unverified");
  const operation = await setupRunRecord(run, deps);
  // The apply run's own receipt: a teardown's carries the same digest, so it must be the setup's.
  const own = (operation.receipt ?? {}) as Record<string, unknown>;
  if (own.migration !== "acceptance-pool-setup-v1" || own.status !== "applied")
    throw refuse("setup_run_invalid");
  const recorded = own.appSha256;
  if (typeof recorded !== "string" || !/^[a-f0-9]{64}$/u.test(recorded))
    throw refuse("pool_digest_missing");
  if (recorded !== appDigest(receipt.app)) throw refuse("pool_digest_differs");
  return { ...receipt, app: receipt.app };
}

/** What the run reports: kinds, counts and digests only. */
export interface TestDeviceReport {
  readonly action: "register" | "revoke";
  readonly outcome: "registered" | "revoked" | "refused";
  readonly reason?: TestDeviceRefusal;
  readonly appSha256?: string;
  /** register: the sealed ids' checksum, which the recipient's decrypt checks. */
  readonly sealedSha256?: string;
}

export async function runTestDevice(
  run: TestDeviceRun,
  deps: TestDeviceDeps = defaults,
): Promise<TestDeviceReport> {
  if (!goPattern.test(run.go)) throw refuse("go_invalid");
  if (
    !/^[a-f0-9]{64}$/u.test(run.setupPlanSha256) ||
    !/^[a-f0-9]{64}$/u.test(run.signingKey) ||
    !/^[1-9][0-9]{0,19}$/u.test(run.setupRun)
  )
    throw refuse("config");
  // The recipient is checked before anything is signed, so a key the ids can't be sealed for
  // never leaves a device registered.
  if (run.action === "register")
    try {
      recipientKey(run.recipient ?? "");
    } catch {
      throw refuse("config");
    }
  // The device to revoke is read before anything is sent, so a missing one sends nothing.
  let device: AcceptanceTestDevice | undefined;
  if (run.action === "revoke")
    try {
      device = acceptanceTestDevice(run.env ?? {});
    } catch (error) {
      if (error instanceof AcceptanceDeviceRefused) throw refuse("device_missing");
      throw error;
    }
  const setup = await provenSetup(run, deps);
  const target = { stage: "production", signingKey: run.signingKey, receipt: setup };
  const appSha256 = appDigest(setup.app);
  mkdirSync(run.outputDirectory, { recursive: true, mode: 0o700 });
  if (run.action === "revoke") {
    await deps.revoke({ ...target, device: device! }).catch(() => {
      throw refuse("revoke_refused");
    });
    return { action: "revoke", outcome: "revoked", appSha256 };
  }
  const registered = await deps
    .register({
      ...target,
      pool: setup.app,
      owner: "acceptance",
      organization: "acceptance",
      user: "acceptance",
    })
    .catch(() => {
      throw refuse("registration_refused");
    });
  let sealed: ReturnType<typeof sealArtifact>;
  try {
    sealed = deps.seal(JSON.stringify(registered), run.recipient!, sealTarget);
    writeFileSync(join(run.outputDirectory, "device.sealed.json"), `${JSON.stringify(sealed)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Registered but its ids neither sealed nor kept: revoke it again, so no device is left whose
    // ids nobody holds. If even that fails, the run says so in its own word.
    const revoked = await deps.revoke({ ...target, device: registered }).then(
      () => true,
      () => false,
    );
    throw refuse(revoked ? "config" : "unsealed_left_registered");
  }
  return { action: "register", outcome: "registered", appSha256, sealedSha256: sealed.sha256 };
}

/** The report as the run's one public line. */
export const reportLine = (report: TestDeviceReport) =>
  [
    `test_device action=${report.action} outcome=${report.outcome}`,
    report.reason ? `reason=${report.reason}` : "",
    report.appSha256 ? `pool_sha256=${report.appSha256}` : "",
    report.sealedSha256 ? `sealed_sha256=${report.sealedSha256}` : "",
  ]
    .filter(Boolean)
    .join(" ");

/** Reads the setup apply run's `operation.json`; a missing or unreadable one is refused later. */
function readSetupOperation(directory: string): unknown {
  try {
    return JSON.parse(readFileSync(join(directory, "operation.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * One run as the workflow makes it: the report goes to the output directory, the step summary and
 * stdout, and nothing else is written but the sealed ids. Returns whether it refused.
 */
export async function runFromEnvironment(
  env: NodeJS.ProcessEnv,
  deps: TestDeviceDeps = defaults,
  print: (line: string) => void = console.log,
): Promise<boolean> {
  const chosen = env.TEST_DEVICE_ACTION;
  const action = chosen === "revoke" ? "revoke" : "register";
  const output = env.TEST_DEVICE_OUTPUT_DIRECTORY ?? "";
  let report: TestDeviceReport;
  try {
    if ((chosen !== "register" && chosen !== "revoke") || !output) throw refuse("config");
    report = await runTestDevice(
      {
        action,
        go: env.TEST_DEVICE_GO ?? "",
        signingKey: env.POOL_APP_SIGNING_KEY ?? "",
        setupPlanSha256: env.TEST_DEVICE_SETUP_PLAN_SHA256 ?? "",
        setupRun: env.TEST_DEVICE_SETUP_RUN ?? "",
        setupOperation: readSetupOperation(env.TEST_DEVICE_SETUP_DIRECTORY ?? ""),
        recipient: env.TEST_DEVICE_RECIPIENT,
        env,
        outputDirectory: output,
      },
      deps,
    );
  } catch (error) {
    report = {
      action,
      outcome: "refused",
      reason: error instanceof TestDeviceRefused ? error.reason : "config",
    };
  }
  // A report that cannot be written is only missing: no error text ever reaches a line.
  if (output)
    try {
      mkdirSync(output, { recursive: true, mode: 0o700 });
      writeFileSync(join(output, "report.json"), `${JSON.stringify(report)}\n`, { mode: 0o600 });
    } catch {
      report = { ...report, outcome: "refused", reason: report.reason ?? "config" };
    }
  const line = reportLine(report);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  print(line);
  return report.outcome === "refused";
}

if (import.meta.main && (await runFromEnvironment(process.env))) process.exitCode = 1;
