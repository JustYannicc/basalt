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

interface Receipt {
  status: "started" | "incomplete" | "complete";
  planSha256: string;
  retainSha256: string;
  removed: string[];
  memberships: string[];
}
export interface RemovalDependencies {
  read(selection: RemovalSelection): Promise<RemovalSnapshot>;
  home(path: string, init: RequestInit): Promise<Response>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  secret: string;
  release: string;
  databaseOrigin: string;
  now?: () => number;
}
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
  ) {
    if (this.busy) throw new RemovalRefused();
    this.busy = true;
    try {
      return await this.perform(
        action,
        removalSelection(rawSelection),
        recipient,
        target,
        approval,
      );
    } finally {
      this.busy = false;
    }
  }

  private database(snapshot: RemovalSnapshot) {
    return sha256(canonical({ origin: this.deps.databaseOrigin, database: snapshot.database }));
  }

  private async perform(
    action: string,
    selection: RemovalSelection,
    recipient: string,
    target: string,
    rawApproval: unknown,
  ) {
    const now = this.deps.now?.() ?? Date.now();
    const protect = (value: unknown) => protectArtifact(value, this.deps.secret, recipient, target);
    if (action === "apply") return this.apply(selection, target, rawApproval, now);
    if (action !== "inventory" && action !== "backup" && action !== "dry-run")
      throw new RemovalRefused(400);
    const snapshot = await this.deps.read(selection);
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
          : await this.deps.storage.get<Receipt>(`import-removal:${query.planSha256}`);
      return {
        action,
        rows: snapshot.credentials.length,
        artifact: await protect({
          selection,
          release: this.deps.release,
          observedAt: now,
          database,
          ...removalProjection(snapshot),
          ...(query.planSha256 === undefined ? {} : { receipt: receipt ?? null }),
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
    const key = `import-removal:${approval.planSha256}`;
    const saved = await this.deps.storage.get<Receipt>(key);
    const snapshot = await this.deps.read(selection);
    if (this.database(snapshot) !== plan.database) throw new RemovalRefused();
    if (saved) {
      if (saved.status !== "complete" || !removalComplete(snapshot, saved.retainSha256))
        throw new RemovalRefused();
      return this.result(saved, true);
    }
    if (sha256(canonical(snapshot)) !== plan.snapshotSha256) throw new RemovalRefused();
    const receipt: Receipt = {
      status: "started",
      planSha256: approval.planSha256,
      retainSha256: snapshot.retain.sha256,
      removed: [],
      memberships: [],
    };
    await this.deps.storage.put(key, receipt);
    try {
      for (const credential of selection.remove) {
        await this.remove(`/credentials?id=${encodeURIComponent(credential.id)}`);
        receipt.removed.push(credential.id);
        await this.deps.storage.put(key, receipt);
      }
      for (const member of snapshot.memberships.filter((row) => !row.deleted)) {
        if (
          (typeof member.id !== "string" && typeof member.id !== "number") ||
          !/^[1-9][0-9]*$/.test(String(member.id))
        )
          throw new RemovalRefused();
        await this.remove(`/channel-group-details/${member.id}`);
        receipt.memberships.push(String(member.id));
        await this.deps.storage.put(key, receipt);
      }
      const after = await this.deps.read(selection);
      if (this.database(after) !== plan.database || !removalComplete(after, snapshot.retain.sha256))
        throw new RemovalRefused();
      receipt.status = "complete";
      await this.deps.storage.put(key, receipt);
      return this.result(receipt, false);
    } catch {
      receipt.status = "incomplete";
      await this.deps.storage.put(key, receipt);
      throw new RemovalRefused();
    }
  }

  private async remove(path: string) {
    const response = await this.deps.home(path, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new RemovalRefused();
  }

  private result(receipt: Receipt, repeated: boolean) {
    return {
      action: "apply",
      planSha256: receipt.planSha256,
      repeated,
      verification: {
        ok: true,
        checks: { credentialsRemoved: true, membershipsRemoved: true, retainedUnchanged: true },
      },
    };
  }
}
