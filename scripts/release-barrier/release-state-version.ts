import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import { readExistingStateContract } from "./retirement-state.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { StateStoreVersionDiagnostic } from "./refusal.ts";

/** A release cannot enter the SDK's lazy bootstrap or upgrade paths before this check. */
export const assertReleaseStateVersion = (
  stack: CompiledStack,
  fetcher = globalThis.fetch,
  phase: StateStoreVersionDiagnostic["phase"] = "release",
) =>
  readExistingStateContract(stack, fetcher).pipe(
    Effect.mapError(
      (error) =>
        new BarrierRefusal("release-state-access", "AlchemyStateStore", {
          fqn: "AlchemyStateStore",
          type: "Alchemy.State",
          changed: [
            { path: "http.status", old: 200, new: error.diagnostics.status ?? "unavailable" },
            { path: "failure.stage", old: null, new: error.stage },
            { path: "failure.causeTag", old: null, new: error.tag },
          ],
        }),
    ),
    Effect.flatMap(({ version }) =>
      version === 8
        ? Effect.void
        : Effect.fail(
            new BarrierRefusal(
              "state-store-version",
              "AlchemyStateStore",
              {
                fqn: "AlchemyStateStore",
                type: "Alchemy.State",
                changed: [{ path: "version", old: version, new: 8 }],
              },
              undefined,
              { phase, expected: 8, observed: version },
            ),
          ),
    ),
  );
