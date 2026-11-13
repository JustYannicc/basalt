import { Effect } from "effect";
import type * as Plan from "alchemy/Plan";
import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { fileURLToPath } from "node:url";
import type { FrozenContainer } from "./container.ts";
import { deploymentSqlSources } from "./sql-schema-sources.ts";
import { releaseHomeImage } from "./home-schema-image.ts";
import { loadSqlSchemaExpectations } from "./sql-schema-expectations.ts";
import { readSqlSchemas } from "./sql-schema-read.ts";
import type { SqlSchemaReceipt } from "./sql-schema-contract.ts";
import { withCandidateHome } from "./home-schema-container.ts";
import { HomeImageMismatchError } from "./home-schema-image-identity.ts";
import { homeSchemaAdmission } from "./home-schema-admission.ts";
import { prepareHomeSchema, HomeSchemaCommandError } from "./home-schema-operation.ts";
import { readSqlSchemaJournal } from "./sql-schema-journal.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { FleetImageResource } from "./runtime-image-phase.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Native preparation and the final six-schema assertion share the admitted release identity. */
export const deploymentSqlSchemas = (options: {
  stack: Pick<CompiledStack, "name" | "stage">;
  candidate: string;
  plan: Plan.Plan;
  state: StateService;
  changedContainers: readonly FrozenContainer[];
  resource?: FleetImageResource;
  encryptionKey: string;
  retryIntentId?: string;
  record(receipt: SqlSchemaReceipt): Promise<void>;
}) =>
  Effect.gen(function* () {
    const authority = yield* deploymentSqlSources(options.state, options.stack);
    const image = yield* releaseHomeImage(
      options.stack,
      options.candidate,
      options.plan,
      options.state,
      options.changedContainers,
      undefined,
      options.resource,
    );
    const prior = yield* readSqlSchemaJournal(options.stack, options.encryptionKey);
    return yield* Effect.tryPromise({
      try: () =>
        withCandidateHome({
          image: image.image,
          credentials: image.credentials,
          databaseUrl: authority.poolUrl,
          work: async (commands) => {
            const expectations = await loadSqlSchemaExpectations(commands.info.target_version);
            const read = () =>
              readSqlSchemas({
                candidate: options.candidate,
                homeImageDigest: image.image.imageDigest,
                expectations,
                sources: authority.sources,
              });
            const initial = await read();
            const reviewed = await homeSchemaAdmission(root);
            const prerequisitesReady = initial.observations.every((entry) =>
              entry.namespace === "home"
                ? entry.applied?.length === 1 &&
                  (entry.status === "ready" || entry.status === "pending") &&
                  entry.unexpected?.length === 0
                : entry.status === "ready" &&
                  entry.pending?.length === 0 &&
                  entry.unexpected?.length === 0,
            );
            const prepared = await prepareHomeSchema({
              identity: image.identity,
              info: commands.info,
              commands,
              prior: prior?.unresolvedHome ?? undefined,
              lastFailure: prior?.lastConfirmedFailure,
              retryIntentId: options.retryIntentId,
              admit: (identity, info, before) =>
                prerequisitesReady && reviewed(identity, info, before),
              record: async (homeMigration) => {
                initial.homeMigration = homeMigration;
                await options.record(initial);
              },
            });
            const receipt = await read();
            receipt.home = prepared.proof;
            receipt.homeMigration = prepared.receipt;
            return receipt;
          },
        }),
      catch: (error) => {
        if (error instanceof BarrierRefusal) return error;
        if (error instanceof HomeImageMismatchError) return error.refusal;
        if (error instanceof HomeSchemaCommandError) {
          const id =
            "containerId" in error &&
            typeof error.containerId === "string" &&
            /^[a-f0-9]{64}$/.test(error.containerId)
              ? error.containerId
              : "candidate";
          return new BarrierRefusal(`home-schema-${error.reason}`, `home ${id}`);
        }
        return new BarrierRefusal("home-schema-operation-failed", "home");
      },
    });
  });
