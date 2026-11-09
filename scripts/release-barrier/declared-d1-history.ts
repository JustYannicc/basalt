import { State } from "alchemy/State/State";
import { Effect } from "effect";
import { canonical } from "./manifest.ts";
import { declarationHistory, declarationHistoryKey } from "./declared-history.ts";
import { d1Mismatch, type PreparedD1 } from "./declared-d1-types.ts";

export const recordD1History = (
  scope: { stack: string; stage: string },
  database: PreparedD1,
  candidate: string,
  status: "pending" | "acknowledged" | "created",
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const output = yield* state.getOutput(scope);
    if (
      output !== undefined &&
      (output === null || typeof output !== "object" || Array.isArray(output))
    )
      throw d1Mismatch(
        "declared-history-output-unsupported",
        database.fqn,
        { outputType: "object" },
        { outputType: typeof output },
      );
    const previous = declarationHistory(output);
    const existing = previous.databases[database.fqn];
    const identity = {
      entry: database.entry,
      instanceId: database.native.instanceId,
      target: database.target,
      providerVersion: database.native.providerVersion,
    };
    if (
      existing &&
      (existing.entry !== identity.entry ||
        existing.instanceId !== identity.instanceId ||
        existing.providerVersion !== identity.providerVersion ||
        canonical(existing.target) !== canonical(identity.target) ||
        (existing.databaseId !== undefined && existing.databaseId !== database.databaseId))
    )
      throw d1Mismatch("declared-history-identity-drift", database.fqn, existing, {
        ...identity,
        databaseId: database.databaseId,
      });
    yield* state.setOutput({
      ...scope,
      value: {
        ...output,
        [declarationHistoryKey]: {
          ...previous,
          databases: {
            ...previous.databases,
            [database.fqn]: {
              ...identity,
              declaration: existing?.declaration ?? database.declaration,
              candidate: existing?.candidate ?? candidate,
              status,
              ...(database.databaseId ? { databaseId: database.databaseId } : {}),
            },
          },
        },
      },
    });
  });
