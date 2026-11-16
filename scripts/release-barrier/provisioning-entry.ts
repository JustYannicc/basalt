import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Schema } from "effect";
import { evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { observationStoreStack } from "./observation-store-stack.ts";
import { ObservationStorePlanRequest } from "./observation-store-contract.ts";
import { planObservationStore } from "./observation-store-plan.ts";
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
  const planRequest =
    mode === "plan"
      ? Schema.decodeUnknownSync(ObservationStorePlanRequest, { onExcessProperty: "error" })(value)
      : undefined;
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
  process.exitCode = await releaseOutcome(evidence, process.env.GITHUB_STEP_SUMMARY, () =>
    Effect.runPromiseExit(
      evalStack(
        planRequest || packet?.operation.kind === "observation-store"
          ? observationStoreStack
          : provisioningStack,
        (compiled) =>
          Effect.gen(function* () {
            yield* assertReleaseStateVersion(compiled);
            const receipt = planRequest
              ? {
                  operation: {
                    kind: "observation-store" as const,
                    manifest: yield* planObservationStore(compiled, planRequest, writer),
                  },
                }
              : mode === "apply"
                ? yield* runDeclaredProvisioning(
                    compiled,
                    packet!,
                    writer,
                    process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                    process.env.POOL_DEPLOYMENT_KEY ?? "",
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
                    ...(packet ? { manifest: provisioningOperationDigest(packet.operation) } : {}),
                    receipt,
                  };
            yield* Effect.promise(() =>
              writeFile(resolve(directory, "receipt.json"), JSON.stringify(output), {
                mode: 0o600,
                flush: true,
              }),
            );
          }).pipe(
            Effect.provideContext(compiled.services),
            Effect.provideService(State, Context.get(compiled.services, State)),
          ),
        { stage: "production" },
      ).pipe(withReleaseRuntime),
    ),
  );
}
