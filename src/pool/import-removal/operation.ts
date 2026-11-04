import { Schema } from "effect";
import {
  canonical,
  openArtifact,
  protectArtifact,
  ProtectedArtifact,
  sha256,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import {
  importRemovalRevision,
  RemovalPlan,
  removalSelection,
  RemovalRefused,
  type RemovalSelection,
} from "./contract.ts";
import { removalComplete, removalProjection, type RemovalSnapshot } from "./snapshot.ts";
import {
  databaseHash,
  executeRemoval,
  removalResult,
  readRemoval,
  saveReceipt,
  type RemovalDependencies,
} from "./execute.ts";
import { RemovalExecutionFailure } from "./failure.ts";
import { receiptKey, recoveryKey, unresolvedRemoval, type RemovalReceipt } from "./receipt.ts";
import { prepareRecovery, resumeRecovery } from "./recovery.ts";

const Approval = Schema.Struct({
  artifact: ProtectedArtifact,
  planSha256: Schema.String,
  backupSha256: Schema.String,
  go: Schema.String,
});

/** A saved started receipt makes an uncertain DELETE stop for inspection instead of being retried. */
export class ImportRemoval {
  private busy = false;
  private readonly deps: RemovalDependencies;
  constructor(deps: RemovalDependencies) {
    this.deps = deps;
  }

  async run(
    action: string,
    rawSelection: unknown,
    recipient: string,
    target: string,
    approval?: unknown,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (this.busy) throw new RemovalRefused();
    this.busy = true;
    try {
      return await this.perform(
        action,
        removalSelection(rawSelection),
        recipient,
        target,
        approval,
        signal,
      );
    } finally {
      this.busy = false;
    }
  }

  private database(snapshot: RemovalSnapshot) {
    return databaseHash(this.deps, snapshot);
  }

  private async perform(
    action: string,
    selection: RemovalSelection,
    recipient: string,
    target: string,
    rawApproval: unknown,
    signal?: AbortSignal,
  ) {
    const now = this.deps.now?.() ?? Date.now();
    const protect = (value: unknown) => protectArtifact(value, this.deps.secret, recipient, target);
    if (action === "prepare")
      return prepareRecovery(this.deps, selection, rawApproval, recipient, target);
    if (action === "resume")
      return resumeRecovery(this.deps, selection, rawApproval, target, signal);
    if (action === "apply") return this.apply(selection, target, rawApproval, now, signal);
    if (action !== "inventory" && action !== "backup" && action !== "dry-run")
      throw new RemovalRefused(400);
    const snapshot = await readRemoval(this.deps, selection);
    const database = this.database(snapshot);
    if (action === "inventory") {
      const query = Schema.decodeUnknownSync(
        Schema.Struct({ planSha256: Schema.optional(Schema.String) }),
      )(rawApproval);
      if (query.planSha256 !== undefined && !/^[a-f0-9]{64}$/.test(query.planSha256))
        throw new RemovalRefused(400);
      const receipt =
        query.planSha256 === undefined
          ? undefined
          : await this.deps.storage.get<RemovalReceipt>(receiptKey(query.planSha256));
      return {
        action,
        rows: snapshot.credentials.length,
        artifact: await protect({
          selection,
          release: this.deps.release,
          observedAt: now,
          database,
          ...removalProjection(snapshot),
          ...(query.planSha256 === undefined
            ? {}
            : {
                receipt: receipt ?? null,
                recoveryPlanSha256:
                  (await this.deps.storage.get<string>(recoveryKey(query.planSha256))) ?? null,
              }),
        }),
      };
    }
    // The retained account's credential material is never fetched or included in this backup.
    const backup = await protect({
      format: "basalt-home-import-backup-v1",
      selection,
      database,
      release: this.deps.release,
      observedAt: now,
      credentials: snapshot.credentials,
      memberships: snapshot.memberships,
    });
    if (action === "backup") return { action, rows: snapshot.credentials.length, artifact: backup };
    if (snapshot.credentials.some((row) => row.deleted)) throw new RemovalRefused();
    const backupSha256 = sha256(`${canonical(backup)}\n`);
    const plan: RemovalPlan = {
      format: "basalt-home-import-removal-v1",
      selection,
      target,
      release: this.deps.release,
      revision: importRemovalRevision,
      database,
      observedAt: now,
      expiresAt: now + 3_600_000,
      snapshotSha256: sha256(canonical(snapshot)),
      backupSha256,
    };
    return {
      action,
      changes: selection.remove.length + snapshot.memberships.filter((row) => !row.deleted).length,
      artifact: await protect({ ...plan, projection: removalProjection(snapshot) }),
      backup,
      backupSha256,
    };
  }

  private async apply(
    selection: RemovalSelection,
    target: string,
    rawApproval: unknown,
    now: number,
    signal?: AbortSignal,
  ) {
    const approval = Schema.decodeUnknownSync(Approval)(rawApproval);
    if (
      !/^[a-f0-9]{64}$/.test(approval.planSha256) ||
      approval.artifact.sha256 !== approval.planSha256 ||
      approval.go !== `GO ${approval.planSha256}`
    )
      throw new RemovalRefused();
    const plan = Schema.decodeUnknownSync(RemovalPlan)(
      await openArtifact(approval.artifact, this.deps.secret, target),
    );
    if (
      plan.target !== target ||
      plan.release !== this.deps.release ||
      plan.revision !== importRemovalRevision ||
      plan.backupSha256 !== approval.backupSha256 ||
      plan.observedAt > now ||
      plan.expiresAt <= now ||
      plan.expiresAt !== plan.observedAt + 3_600_000 ||
      canonical(plan.selection) !== canonical(selection)
    )
      throw new RemovalRefused();
    const key = receiptKey(approval.planSha256);
    const saved = await this.deps.storage.get<RemovalReceipt>(key);
    const snapshot = await readRemoval(this.deps, selection);
    if (this.database(snapshot) !== plan.database) throw new RemovalRefused();
    if (saved) {
      if (saved.status !== "complete" || !removalComplete(snapshot, saved.retainSha256))
        throw new RemovalRefused();
      return removalResult(saved, "apply", true);
    }
    // Legacy receipts predate a selection index. Refuse any uncertain removal in this controller.
    if (await unresolvedRemoval(this.deps.storage))
      throw new RemovalExecutionFailure({
        phase: "receipt",
        code: "recovery_required",
        elapsedMs: 0,
      });
    if (sha256(canonical(snapshot)) !== plan.snapshotSha256) throw new RemovalRefused();
    const receipt: RemovalReceipt = {
      status: "started",
      planSha256: approval.planSha256,
      retainSha256: snapshot.retain.sha256,
      removed: [],
      memberships: [],
    };
    await saveReceipt(this.deps, key, receipt);
    return removalResult(
      await executeRemoval(this.deps, selection, snapshot, receipt, key, plan.expiresAt, signal),
      "apply",
      false,
    );
  }
}
