import { Schema } from "effect";
import { poolObservationTokenProps } from "../../src/pool/fleet-observation.ts";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Account = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
export const ObservationTokenManifest = Schema.Struct({
  format: Schema.Literal("pool-observation-token-provisioning-v1"),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  stack: Schema.NonEmptyString,
  stage: Schema.NonEmptyString,
  instanceId: Schema.NonEmptyString,
  accountId: Account,
  sdkSourceDigest: Hash,
  audit: Schema.Struct({
    accountId: Account,
    tokenWriteGranted: Schema.Literal(true),
    evidenceDigest: Hash,
  }),
});
export type ObservationTokenManifest = typeof ObservationTokenManifest.Type;
export const decodeObservationTokenManifest = decodeProvisioningInput(
  ObservationTokenManifest,
  "observationToken.manifest",
);
export const observationTokenDigest = (input: ObservationTokenManifest) =>
  digest(canonical(decodeObservationTokenManifest(input)));
export const observationTokenProps = (manifest: ObservationTokenManifest) =>
  poolObservationTokenProps(manifest.accountId, manifest.stage);

export function assertObservationTokenEnable(
  manifest: ObservationTokenManifest,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  sameProvisioningValue(
    "observationToken.audit.account",
    manifest.accountId,
    manifest.audit.accountId,
  );
  if (
    !enable?.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== observationTokenDigest(manifest) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    !Number.isSafeInteger(now) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "observation-token-not-enabled",
      "observationToken.enable",
      observationTokenDigest(manifest),
      enable?.manifest ?? null,
    );
}
