import { Effect, Schema } from "effect";
import { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { UnattestedAdoptionReadback } from "../../src/pool/runtime-slots/adoption-readback.ts";
import { decodeRuntimeHandoffCommand } from "../../src/pool/runtime-slots/handoff-command.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import type { RuntimeProvisioningManifest } from "./provisioning-contract.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

export const ProvisioningActiveRead = Schema.Struct({
  controllerCode: ControllerCode,
  controller: Schema.Struct({
    accountId: Schema.NonEmptyString,
    scriptName: Schema.NonEmptyString,
  }),
  bridgeKeyDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  target: SlotTarget,
});
export type ProvisioningActiveRead = typeof ProvisioningActiveRead.Type;
const response = Schema.decodeUnknownSync(Schema.Struct({ result: UnattestedAdoptionReadback }), {
  onExcessProperty: "error",
});

/** Bootstrap preserves an adopted legacy boot. Passive witness and provider reads never start or repair it. */
export const readProvisioningActive = (
  manifest: RuntimeProvisioningManifest,
  read: ProvisioningActiveRead,
  signingKey: string,
  io: { connect?: PoolOperationsTarget["connect"]; fetcher?: Fetcher; now?: () => number } = {},
) =>
  Effect.gen(function* () {
    sameProvisioningValue(
      "provisioning.active.signer",
      read.bridgeKeyDigest,
      runtimeBridgeKeyDigest(signingKey),
    );
    sameProvisioningValue(
      "provisioning.active.account",
      manifest.declaration.accountId,
      read.controller.accountId,
    );
    sameProvisioningValue(
      "provisioning.active.application",
      manifest.active.applicationId,
      read.target.applicationId,
    );
    sameProvisioningValue(
      "provisioning.active.version",
      String(manifest.active.version),
      read.target.applicationVersion,
    );
    const provider = {
      target: read.target,
      provider: {
        accountId: read.controller.accountId,
        namespaceId: manifest.active.namespaceId,
        applicationConfigDigest: manifest.active.configurationDigest,
      },
    };
    const now = io.now ?? Date.now;
    yield* readRuntimeProviderProof(provider, "runtime", io.fetcher, now);
    const at = now();
    const command = decodeRuntimeHandoffCommand(
      {
        action: "witness",
        target: read.target,
        controllerCode: read.controllerCode,
        at,
        expiresAt: at + 60_000,
      },
      at,
    );
    const observed = response(
      yield* Effect.promise(() =>
        sendRuntimeCommand(
          command,
          signingKey,
          {
            accountId: read.controller.accountId,
            worker: read.controller.scriptName,
            connect: io.connect,
          },
          () => {
            decodeRuntimeHandoffCommand(command, now());
          },
        ),
      ),
    ).result;
    const identity = { ...read.target, bootId: manifest.active.bootId };
    sameProvisioningValue(
      "provisioning.active.controller",
      read.controllerCode,
      observed.controllerCode,
    );
    sameProvisioningValue("provisioning.active.identity", identity, observed.identity);
    sameProvisioningValue("provisioning.active.selection", identity, observed.selection.active);
    sameProvisioningValue(
      "provisioning.active.epoch",
      manifest.active.selectionEpoch,
      observed.selection.expectedEpoch,
    );
    yield* readRuntimeProviderProof(provider, "application", io.fetcher, now);
    return { ...manifest.active };
  });
