import type { PreparedPlan } from "./alchemy-plan.ts";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import type { ClassRecord } from "./class-history.ts";
import { classRequestVerdict } from "./declared-class-contract.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { BarrierRefusal } from "./manifest.ts";
import { versionMetadata } from "./version-request.ts";

/** Check the whole captured request set before any additive live mutation, retaining each independent refusal. */
export function assertClassRequests(
  prepared: Pick<PreparedPlan, "captured">,
  entries: readonly SqliteClassDeclaration[],
  history: Readonly<Record<string, ClassRecord>>,
) {
  const failures: BarrierRefusal[] = [];
  for (const fqn of Object.keys(history))
    if (!entries.some((entry) => entry.fqn === fqn))
      failures.push(
        declaredMismatch(
          "declared-class-declaration-removed",
          fqn,
          { declaration: "retained" },
          { declaration: null },
          "Cloudflare.Worker",
        ),
      );
  for (const [fqn, upload] of prepared.captured) {
    const entry = entries.find((entry) => entry.fqn === fqn);
    const saved = history[fqn];
    try {
      if (entry && (!saved || ["clone-pending", "clone-ready"].includes(saved.status)))
        classRequestVerdict(upload, entry);
      else versionMetadata(upload);
    } catch (error) {
      if (!(error instanceof BarrierRefusal)) throw error;
      failures.push(error);
    }
  }
  const first = failures[0];
  if (!first) return;
  if (failures.length === 1) throw first;
  throw new BarrierRefusal(
    first.reason,
    first.worker,
    first.delta,
    failures.flatMap((error) => error.refusals ?? [{ reason: error.reason, ...error.delta! }]),
  );
}
