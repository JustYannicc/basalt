import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";

export const observationStoreFqn = "PoolObservationSecrets";
export const observationStoreType = "Cloudflare.SecretsStore";
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ObservationStoreIdentity = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  storeId: Schema.NonEmptyString,
  storeName: Schema.NonEmptyString,
});
export const ObservationStoreManifest = Schema.Struct({
  format: Schema.Literal("pool-observation-store-adoption-v1"),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  stack: Schema.Literal("basalt"),
  stage: Schema.Literal("production"),
  operationId: Schema.NonEmptyString,
  ...ObservationStoreIdentity.fields,
  absentRowDigest: hash,
  sdkSourceDigest: hash,
  declarationDigest: hash,
});
export type ObservationStoreManifest = typeof ObservationStoreManifest.Type;
export const ObservationStorePlanRequest = Schema.Struct({
  kind: Schema.Literal("observation-store"),
  operationId: Schema.NonEmptyString,
  coordinatorGo: Schema.NonEmptyString,
  expiresAt: Schema.Int,
});
export const observationStoreDigest = (value: ObservationStoreManifest) =>
  digest(
    canonical(
      Schema.decodeUnknownSync(ObservationStoreManifest, { onExcessProperty: "error" })(value),
    ),
  );
export const observationStoreAbsentDigest = digest(
  canonical({
    stack: "basalt",
    stage: "production",
    fqn: observationStoreFqn,
    row: null,
  }),
);

/** Freeze both runtimes: Bun loads source while Node loads the published JS. */
export function observationStoreSdkDigest() {
  const entry = pathToFileURL(createRequire(import.meta.url).resolve("alchemy"));
  return digest(
    canonical(
      ["Cloudflare/SecretsStore/SecretsStore", "Plan", "Apply"].flatMap((name) =>
        ["src", "lib"].map((tree) => ({
          path: `${tree}/${name}`,
          digest: digest(
            readFileSync(new URL(`../${tree}/${name}.${tree === "src" ? "ts" : "js"}`, entry)),
          ),
        })),
      ),
    ),
  );
}
export function assertObservationStoreEnable(
  manifest: ObservationStoreManifest,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  if (
    !enable?.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== observationStoreDigest(manifest) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "observation-store-not-enabled",
      "observationStore.go",
      "reviewed-unexpired-GO",
      "unavailable",
    );
}
