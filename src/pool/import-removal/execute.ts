import {
  canonical,
  sha256,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import { homeResponse } from "../home-response.ts";
import { RemovalRefused, type RemovalSelection } from "./contract.ts";
import { executionFailure, homeFailure, RemovalExecutionFailure } from "./failure.ts";
import type { RemovalReceipt } from "./receipt.ts";
import { removalComplete, type RemovalSnapshot } from "./snapshot.ts";

export interface RemovalDependencies {
  read(selection: RemovalSelection): Promise<RemovalSnapshot>;
  ready(): Promise<void>;
  home(path: string, init: RequestInit): Promise<Response>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    put(entries: Record<string, unknown>): Promise<void>;
    list(options: { prefix: string; limit: number }): Promise<Map<string, unknown>>;
  };
  secret: string;
  release: string;
  databaseOrigin: string;
  now?: () => number;
}

export const databaseHash = (deps: RemovalDependencies, snapshot: RemovalSnapshot) =>
  sha256(canonical({ origin: deps.databaseOrigin, database: snapshot.database }));

export async function readRemoval(
  deps: RemovalDependencies,
  selection: RemovalSelection,
  phase: "snapshot" | "verify" = "snapshot",
) {
  const started = Date.now();
  try {
    return await deps.read(selection);
  } catch (error) {
    if (error instanceof RemovalRefused) throw error;
    throw executionFailure(error, phase, started);
  }
}

export async function saveReceipt(deps: RemovalDependencies, key: string, receipt: RemovalReceipt) {
  const started = Date.now();
  try {
    await deps.storage.put(key, receipt);
  } catch (error) {
    throw executionFailure(error, "receipt", started);
  }
}

/** Each acknowledgement is verified before progress advances; an uncertain write stays pending. */
export async function executeRemoval(
  deps: RemovalDependencies,
  selection: RemovalSelection,
  initial: RemovalSnapshot,
  receipt: RemovalReceipt,
  key: string,
  expiresAt: number,
  requestSignal?: AbortSignal,
) {
  let expected = initial;
  const steps = [
    ...selection.remove.map((row) => ({
      kind: "credential" as const,
      id: row.id,
      path: `/credentials/conditional?id=${encodeURIComponent(row.id)}`,
    })),
    ...initial.memberships.map((row) => ({
      kind: "membership" as const,
      id: row.id,
      path: `/channel-group-details/${row.id}/conditional`,
    })),
  ];
  try {
    for (const step of steps) {
      const rows = step.kind === "credential" ? expected.credentials : expected.memberships;
      const row = rows.find((row) => row.id === step.id);
      if (!row || !/^(?:[a-f0-9-]{36}|[1-9][0-9]*)$/.test(row.id)) throw new RemovalRefused();
      if (row.deleted) continue;
      requestSignal?.throwIfAborted();
      let started = Date.now();
      try {
        await deps.ready();
        requestSignal?.throwIfAborted();
      } catch (error) {
        throw executionFailure(error, "readiness", started, step.id);
      }
      // Warmup may refresh tokens. Such a change needs a newly reviewed plan, before any DELETE.
      const current = await readRemoval(deps, selection);
      requestSignal?.throwIfAborted();
      if (canonical(current) !== canonical(expected) || (deps.now?.() ?? Date.now()) >= expiresAt)
        throw new RemovalExecutionFailure({
          phase: "snapshot",
          code: "snapshot_changed",
          elapsedMs: 0,
          rowId: step.id,
        });
      receipt.pending = { kind: step.kind, id: step.id, beforeSha256: sha256(row.row) };
      await saveReceipt(deps, key, receipt);
      requestSignal?.throwIfAborted();
      if ((deps.now?.() ?? Date.now()) >= expiresAt)
        throw new RemovalExecutionFailure({
          phase: "snapshot",
          code: "snapshot_changed",
          elapsedMs: 0,
          rowId: step.id,
        });
      started = Date.now();
      const phase = step.kind === "credential" ? "credential-delete" : "membership-delete";
      const deadline = AbortSignal.timeout(10_000);
      const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
      try {
        await homeResponse(async () => {
          const response = await deps.home(step.path, {
            method: "DELETE",
            signal,
            headers: { "if-match": `"${sha256(row.row)}"` },
          });
          if (response.status === 412) {
            await response.body?.cancel();
            throw new RemovalExecutionFailure({
              phase,
              code: "snapshot_changed",
              elapsedMs: Date.now() - started,
              rowId: step.id,
            });
          }
          if (!response.ok) throw await homeFailure(response, phase, started, step.id);
          await response.body?.cancel();
          return response;
        }, signal);
      } catch (error) {
        throw executionFailure(error, phase, started, step.id);
      }
      const after = await readRemoval(deps, selection, "verify");
      const changed = step.kind === "credential" ? after.credentials : after.memberships;
      const tombstone = changed.find((row) => row.id === step.id);
      const unchanged = (
        before: { id: string; row: string }[],
        next: { id: string; row: string }[],
        kind: typeof step.kind,
      ) =>
        before.length === next.length &&
        before.every(
          (row) =>
            (kind === step.kind && row.id === step.id) ||
            next.some((other) => other.id === row.id && other.row === row.row),
        );
      if (
        !tombstone?.deleted ||
        after.database !== expected.database ||
        canonical(after.retain) !== canonical(expected.retain) ||
        !unchanged(expected.credentials, after.credentials, "credential") ||
        !unchanged(expected.memberships, after.memberships, "membership")
      )
        throw new RemovalExecutionFailure({
          phase: "verify",
          code: "verification_failed",
          elapsedMs: 0,
          rowId: step.id,
        });
      expected = after;
      (step.kind === "credential" ? receipt.removed : receipt.memberships).push(step.id);
      delete receipt.pending;
      await saveReceipt(deps, key, receipt);
    }
    const after = await readRemoval(deps, selection, "verify");
    if (!removalComplete(after, receipt.retainSha256) || after.database !== initial.database)
      throw new RemovalExecutionFailure({
        phase: "verify",
        code: "verification_failed",
        elapsedMs: 0,
      });
    receipt.status = "complete";
    delete receipt.failure;
    await saveReceipt(deps, key, receipt);
    return receipt;
  } catch (error) {
    const failure =
      error instanceof RemovalExecutionFailure
        ? error
        : executionFailure(error, "snapshot", Date.now());
    receipt.status = "incomplete";
    receipt.failure = failure.diagnostic;
    await saveReceipt(deps, key, receipt);
    throw failure;
  }
}

export function removalResult(
  receipt: RemovalReceipt,
  action: "apply" | "resume",
  repeated: boolean,
) {
  return {
    action,
    planSha256: receipt.planSha256,
    ...(receipt.originalPlanSha256 ? { originalPlanSha256: receipt.originalPlanSha256 } : {}),
    repeated,
    verification: {
      ok: true,
      checks: { credentialsRemoved: true, membershipsRemoved: true, retainedUnchanged: true },
    },
  };
}
