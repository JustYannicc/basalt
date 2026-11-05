import { Schema } from "effect";
import {
  canonical,
  openArtifact,
  protectArtifact,
  ProtectedArtifact,
  sha256,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import { RemovalPlan, RemovalRefused, Selection, type RemovalSelection } from "./contract.ts";
import {
  databaseHash,
  executeRemoval,
  removalResult,
  readRemoval,
  type RemovalDependencies,
} from "./execute.ts";
import { executionFailure, RemovalExecutionFailure } from "./failure.ts";
import { importRecoveryRevision } from "./paths.ts";
import { Receipt, receiptHash, receiptKey, recoveryKey, type RemovalReceipt } from "./receipt.ts";
import { removalComplete, removalProjection } from "./snapshot.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Link = Schema.Struct({ planSha256: Hash, receiptSha256: Hash });
const RecoveryPlan = Schema.Struct({
  format: Schema.Literal("basalt-home-import-recovery-v1"),
  selection: Selection,
  target: Schema.String,
  release: Schema.String,
  revision: Schema.String,
  database: Hash,
  observedAt: Schema.Number,
  expiresAt: Schema.Number,
  snapshotSha256: Hash,
  backupSha256: Hash,
  originalPlanSha256: Hash,
  originalBackupSha256: Hash,
  originalReceiptSha256: Hash,
  priorRecovery: Schema.NullOr(Link),
  retainSha256: Hash,
});
const Original = Schema.Struct({
  originalArtifact: ProtectedArtifact,
  originalPlanSha256: Hash,
  originalBackupSha256: Hash,
});
const Approval = Schema.Struct({
  artifact: ProtectedArtifact,
  planSha256: Hash,
  backupSha256: Hash,
  go: Schema.String,
});
const OriginalProjection = Schema.Struct({
  projection: Schema.Struct({
    credentials: Schema.Array(Schema.Struct({ id: Schema.String, provider: Schema.String })),
    memberships: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        credential: Schema.String,
        pool: Schema.String,
        channel: Schema.NullOr(Schema.String),
      }),
    ),
    retain: Schema.Struct({ id: Schema.String, provider: Schema.String, sha256: Hash }),
  }),
});

async function originalReceipt(deps: RemovalDependencies, hash: string) {
  const saved = await deps.storage.get<RemovalReceipt>(receiptKey(hash));
  if (!saved || saved.planSha256 !== hash || saved.status === "complete")
    throw new RemovalRefused();
  Schema.decodeUnknownSync(Receipt)(saved);
  return saved;
}

/** Preparation only reads existing receipts; the reviewed resume creates a separate linked receipt. */
export async function prepareRecovery(
  deps: RemovalDependencies,
  selection: RemovalSelection,
  raw: unknown,
  recipient: string,
  target: string,
) {
  const input = Schema.decodeUnknownSync(Original)(raw);
  if (input.originalArtifact.sha256 !== input.originalPlanSha256) throw new RemovalRefused();
  const opened = await openArtifact(input.originalArtifact, deps.secret, target);
  const original = Schema.decodeUnknownSync(RemovalPlan)(opened);
  const projection = Schema.decodeUnknownSync(OriginalProjection)(opened).projection;
  if (
    original.target !== target ||
    canonical(original.selection) !== canonical(selection) ||
    original.backupSha256 !== input.originalBackupSha256
  )
    throw new RemovalRefused();
  const saved = await originalReceipt(deps, input.originalPlanSha256);
  const snapshot = await readRemoval(deps, selection);
  if (
    databaseHash(deps, snapshot) !== original.database ||
    canonical(projection.retain) !== canonical(snapshot.retain) ||
    saved.retainSha256 !== snapshot.retain.sha256
  )
    throw new RemovalExecutionFailure({
      phase: "snapshot",
      code: "retained_changed",
      elapsedMs: 0,
    });
  const identities = (rows: readonly { id: string; provider: string }[]) =>
    rows.map(({ id, provider }) => ({ id, provider }));
  const members = (
    rows: readonly { id: string; credential: string; pool: string; channel: string | null }[],
  ) => rows.map(({ id, credential, pool, channel }) => ({ id, credential, pool, channel }));
  if (
    canonical(identities(snapshot.credentials)) !== canonical(identities(projection.credentials)) ||
    canonical(members(snapshot.memberships)) !== canonical(members(projection.memberships)) ||
    saved.removed.some((id) => !snapshot.credentials.some((row) => row.id === id && row.deleted)) ||
    saved.memberships.some(
      (id) => !snapshot.memberships.some((row) => row.id === id && row.deleted),
    )
  )
    throw new RemovalRefused();
  const head = await deps.storage.get<string>(recoveryKey(input.originalPlanSha256));
  const previous = head ? await deps.storage.get<RemovalReceipt>(receiptKey(head)) : undefined;
  if (
    head &&
    (!previous ||
      previous.originalPlanSha256 !== input.originalPlanSha256 ||
      previous.status === "complete" ||
      previous.removed.some(
        (id) => !snapshot.credentials.some((row) => row.id === id && row.deleted),
      ) ||
      previous.memberships.some(
        (id) => !snapshot.memberships.some((row) => row.id === id && row.deleted),
      ))
  )
    throw new RemovalRefused();
  const priorRecovery =
    head && previous ? { planSha256: head, receiptSha256: receiptHash(previous) } : null;
  const backup = await protectArtifact(
    {
      format: "basalt-home-import-backup-v1",
      selection,
      database: original.database,
      release: deps.release,
      observedAt: deps.now?.() ?? Date.now(),
      credentials: snapshot.credentials,
      memberships: snapshot.memberships,
    },
    deps.secret,
    recipient,
    target,
  );
  const now = deps.now?.() ?? Date.now();
  const backupSha256 = sha256(`${canonical(backup)}\n`);
  const plan = {
    format: "basalt-home-import-recovery-v1",
    selection,
    target,
    release: deps.release,
    revision: importRecoveryRevision,
    database: original.database,
    observedAt: now,
    expiresAt: now + 3_600_000,
    snapshotSha256: sha256(canonical(snapshot)),
    backupSha256,
    originalPlanSha256: input.originalPlanSha256,
    originalBackupSha256: input.originalBackupSha256,
    originalReceiptSha256: receiptHash(saved),
    priorRecovery,
    retainSha256: snapshot.retain.sha256,
    projection: removalProjection(snapshot),
  };
  return {
    action: "prepare",
    changes:
      snapshot.credentials.filter((row) => !row.deleted).length +
      snapshot.memberships.filter((row) => !row.deleted).length,
    artifact: await protectArtifact(plan, deps.secret, recipient, target),
    backup,
    backupSha256,
  };
}

export async function resumeRecovery(
  deps: RemovalDependencies,
  selection: RemovalSelection,
  raw: unknown,
  target: string,
  signal?: AbortSignal,
) {
  const approval = Schema.decodeUnknownSync(Approval)(raw);
  if (
    approval.artifact.sha256 !== approval.planSha256 ||
    approval.go !== `GO ${approval.planSha256}`
  )
    throw new RemovalRefused();
  const plan = Schema.decodeUnknownSync(RecoveryPlan)(
    await openArtifact(approval.artifact, deps.secret, target),
  );
  const now = deps.now?.() ?? Date.now();
  if (
    plan.target !== target ||
    plan.release !== deps.release ||
    plan.revision !== importRecoveryRevision ||
    plan.backupSha256 !== approval.backupSha256 ||
    plan.observedAt > now ||
    plan.expiresAt <= now ||
    plan.expiresAt !== plan.observedAt + 3_600_000 ||
    canonical(plan.selection) !== canonical(selection)
  )
    throw new RemovalRefused();
  const original = await originalReceipt(deps, plan.originalPlanSha256);
  if (receiptHash(original) !== plan.originalReceiptSha256)
    throw new RemovalExecutionFailure({ phase: "receipt", code: "receipt_changed", elapsedMs: 0 });
  const snapshot = await readRemoval(deps, selection);
  if (
    databaseHash(deps, snapshot) !== plan.database ||
    snapshot.retain.sha256 !== plan.retainSha256
  )
    throw new RemovalRefused();
  const key = receiptKey(approval.planSha256);
  const existing = await deps.storage.get<RemovalReceipt>(key);
  if (existing) {
    if (
      existing.status !== "complete" ||
      existing.originalPlanSha256 !== plan.originalPlanSha256 ||
      !removalComplete(snapshot, plan.retainSha256)
    )
      throw new RemovalExecutionFailure({
        phase: "receipt",
        code: "recovery_required",
        elapsedMs: 0,
      });
    return removalResult(existing, "resume", true);
  }
  const head = await deps.storage.get<string>(recoveryKey(plan.originalPlanSha256));
  if (head !== (plan.priorRecovery?.planSha256 ?? undefined)) throw new RemovalRefused();
  if (
    plan.priorRecovery &&
    receiptHash(await deps.storage.get(receiptKey(plan.priorRecovery.planSha256))) !==
      plan.priorRecovery.receiptSha256
  )
    throw new RemovalRefused();
  if (sha256(canonical(snapshot)) !== plan.snapshotSha256)
    throw new RemovalExecutionFailure({
      phase: "snapshot",
      code: "snapshot_changed",
      elapsedMs: 0,
    });
  const receipt: RemovalReceipt = {
    status: "started",
    planSha256: approval.planSha256,
    originalPlanSha256: plan.originalPlanSha256,
    ...(head ? { priorRecoveryPlanSha256: head } : {}),
    retainSha256: plan.retainSha256,
    removed: snapshot.credentials.filter((row) => row.deleted).map((row) => row.id),
    memberships: snapshot.memberships.filter((row) => row.deleted).map((row) => row.id),
  };
  // The head and its progress become visible together, including after an object restart.
  const started = Date.now();
  try {
    await deps.storage.put({
      [key]: receipt,
      [recoveryKey(plan.originalPlanSha256)]: approval.planSha256,
    });
  } catch (error) {
    throw executionFailure(error, "receipt", started);
  }
  return removalResult(
    await executeRemoval(deps, selection, snapshot, receipt, key, plan.expiresAt, signal),
    "resume",
    false,
  );
}
