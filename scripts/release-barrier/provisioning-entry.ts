import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { observationStoreEnvelope } from "./observation-store-envelope.ts";
import { evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { observationStoreStack } from "./observation-store-stack.ts";
import { JournalRestorePlanRequest } from "./journal-restore-contract.ts";
import { planJournalRestore } from "./journal-restore.ts";
import { assertAdoptionRunPin, loadAdoptionProof } from "./journal-restore-proof.ts";
import { ObservationStorePlanRequest } from "./observation-store-contract.ts";
import { assertObservationStorePlanGo, planObservationStore } from "./observation-store-plan.ts";
import { provisioningStack } from "./provisioning-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import {
  decodeProvisioningPacket,
  provisioningOperationDigest,
  validateProvisioningOperation,
  runDeclaredProvisioning,
  inspectDeclaredProvisioning,
} from "./provisioning-operation.ts";
import { releaseEvidence } from "./evidence.ts";
import { releaseOutcome } from "./entry-outcome.ts";
import { ReleaseSettlementPlanRequest } from "./release-settlement-contract.ts";
import {
  assertReleaseSettlementPlanGo,
  planReleaseSettlement,
} from "./release-settlement-operation.ts";
import { releaseStateStack } from "./release-state-stack.ts";

/** Only the main-only workflow holding deploy-production may supply the writer identity. */
export function provisioningWorkflowWriter(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !env.GITHUB_WORKFLOW_REF?.endsWith(
      "/.github/workflows/pool-runtime-provision.yml@refs/heads/main",
    ) ||
    !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "") ||
    !/^[0-9]+$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[0-9]+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[a-f0-9]{32}$/u.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
    env.ALCHEMY_STAGE !== "production"
  )
    throw new Error("Provisioning requires the main workflow's exclusive production writer");
  return {
    candidate: env.GITHUB_SHA!,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    lease: `deploy-production:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
  };
}

function readInput(text: string) {
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new Error("Provisioning packet exceeds its limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Provisioning packet is invalid JSON");
  }
  return value;
}

if (import.meta.main && process.argv[2] === "digest") {
  if (process.argv.length !== 4) throw new Error("Use digest <reviewed-packet.json>");
  const packet = decodeProvisioningPacket(
    readInput(await readFile(resolve(process.argv[3]!), "utf8")),
  );
  process.stdout.write(`${provisioningOperationDigest(packet.operation)}\n`);
} else if (import.meta.main) {
  const writer = provisioningWorkflowWriter(process.env);
  const mode = process.env.POOL_PROVISIONING_MODE;
  if (mode !== "apply" && mode !== "inspect" && mode !== "plan")
    throw new Error("Choose plan, inspect or apply");
  const value = readInput(process.env.POOL_PROVISIONING_PACKET ?? "null");
  const packet = mode === "plan" ? undefined : decodeProvisioningPacket(value);
  if (mode === "apply") validateProvisioningOperation(packet!, writer, Date.now());
  const directory = resolve(
    process.env.POOL_PROVISIONING_OUTPUT_DIRECTORY ?? ".local/pool-provisioning",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = releaseEvidence(
    directory,
    writer.candidate,
    process.env.EXECUTOR_ENCRYPTION_KEY,
  );
  process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
  const nativeFetch = globalThis.fetch;
  const envelope =
    mode === "plan" ||
    packet?.operation.kind === "observation-store" ||
    packet?.operation.kind === "observation-store-restore" ||
    packet?.operation.kind === "release-settlement"
      ? observationStoreEnvelope(
          writer.accountId,
          (entry) =>
            appendFile(resolve(directory, "network-requests.jsonl"), JSON.stringify(entry) + "\n", {
              mode: 0o600,
              flush: true,
            }),
          nativeFetch,
        )
      : undefined;
  if (envelope) globalThis.fetch = envelope.fetch;
  try {
    process.exitCode = await releaseOutcome(evidence, process.env.GITHUB_STEP_SUMMARY, () =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const planRequest =
            mode === "plan"
              ? yield* Schema.decodeUnknownEffect(
                  Schema.Union([
                    ObservationStorePlanRequest,
                    JournalRestorePlanRequest,
                    ReleaseSettlementPlanRequest,
                  ]),
                  {
                    onExcessProperty: "error",
                  },
                )(value)
              : undefined;
          if (planRequest?.kind === "release-settlement")
            assertReleaseSettlementPlanGo(planRequest, Date.now());
          else if (planRequest) assertObservationStorePlanGo(planRequest, Date.now());
          const restore =
            planRequest?.kind === "observation-store-restore"
              ? planRequest
              : packet?.operation.kind === "observation-store-restore"
                ? packet.operation.manifest
                : undefined;
          if (restore) assertAdoptionRunPin(restore.source, process.env);
          const adoptionProof =
            restore && mode !== "inspect"
              ? yield* Effect.promise(() =>
                  loadAdoptionProof(restore.source, restore.adoption, process.env),
                )
              : undefined;
          envelope?.beginAuth();
          return yield* evalStack(
            planRequest?.kind === "release-settlement" ||
              packet?.operation.kind === "release-settlement"
              ? releaseStateStack
              : planRequest ||
                  packet?.operation.kind === "observation-store" ||
                  packet?.operation.kind === "observation-store-restore"
                ? observationStoreStack
                : provisioningStack,
            (compiled) =>
              Effect.gen(function* () {
                if (envelope) {
                  yield* Effect.gen(function* () {
                    yield* assertReleaseStateVersion(compiled);
                    // Resolve the SDK's lazy State login before closing the auth-only exception.
                    yield* yield* State;
                  }).pipe(Effect.timeout("60 seconds"));
                  envelope.endAuth();
                } else yield* assertReleaseStateVersion(compiled);
                const receipt = planRequest
                  ? {
                      operation:
                        planRequest.kind === "release-settlement"
                          ? {
                              kind: "release-settlement" as const,
                              manifest: yield* planReleaseSettlement(
                                compiled,
                                planRequest,
                                writer,
                                process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                                {
                                  directory,
                                  runtimeRead: (call) =>
                                    appendFile(
                                      resolve(directory, "runtime-reads.jsonl"),
                                      JSON.stringify(call) + "\n",
                                      { mode: 0o600, flush: true },
                                    ),
                                },
                              ),
                            }
                          : planRequest.kind === "observation-store-restore"
                            ? {
                                kind: "observation-store-restore" as const,
                                manifest: yield* planJournalRestore(
                                  compiled,
                                  planRequest,
                                  writer,
                                  adoptionProof!,
                                  process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                                ),
                              }
                            : {
                                kind: "observation-store" as const,
                                manifest: yield* planObservationStore(
                                  compiled,
                                  planRequest,
                                  writer,
                                ),
                              },
                    }
                  : mode === "apply"
                    ? yield* runDeclaredProvisioning(
                        compiled,
                        packet!,
                        writer,
                        process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                        process.env.POOL_DEPLOYMENT_KEY ?? "",
                        {
                          adoptionProof,
                          settlement: {
                            directory,
                            runtimeRead: (call) =>
                              appendFile(
                                resolve(directory, "runtime-reads.jsonl"),
                                JSON.stringify(call) + "\n",
                                { mode: 0o600, flush: true },
                              ),
                            intent: (intent) =>
                              writeFile(
                                resolve(directory, "settlement-intent.json"),
                                JSON.stringify(intent, null, 2),
                                { mode: 0o600, flush: true },
                              ),
                          },
                        },
                      )
                    : yield* inspectDeclaredProvisioning(
                        compiled,
                        packet!,
                        writer,
                        process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                      );
                const output =
                  planRequest && "operation" in receipt
                    ? {
                        disposition: "plan",
                        ...receipt,
                        operationDigest: provisioningOperationDigest(receipt.operation),
                      }
                    : {
                        disposition: mode,
                        ...(packet
                          ? { manifest: provisioningOperationDigest(packet.operation) }
                          : {}),
                        receipt,
                      };
                envelope?.assertClean();
                yield* Effect.promise(() =>
                  writeFile(
                    resolve(directory, "receipt.json"),
                    JSON.stringify({
                      ...output,
                      ...(envelope ? { networkEnvelope: envelope.receipt() } : {}),
                    }),
                    {
                      mode: 0o600,
                      flush: true,
                    },
                  ),
                );
              }).pipe(
                Effect.provideContext(compiled.services),
                Effect.provideService(State, Context.get(compiled.services, State)),
              ),
            { stage: "production" },
          );
        }).pipe(
          withReleaseRuntime,
          Effect.provideService(FetchHttpClient.Fetch, envelope?.fetch ?? nativeFetch),
        ),
      ),
    );
  } finally {
    if (envelope) {
      globalThis.fetch = nativeFetch;
      await writeFile(
        resolve(directory, "network-envelope.json"),
        JSON.stringify(envelope.receipt()),
        { mode: 0o600, flush: true },
      );
    }
  }
}
