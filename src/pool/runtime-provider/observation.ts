import { Schema } from "effect";
import { ProviderApplicationProof } from "../runtime-slots/admission-proof.ts";
import { ProviderObservationRefused, RuntimeProviderReader } from "./read.ts";

export const ProviderObservationTarget = Schema.Struct({
  accountId: ProviderApplicationProof.fields.accountId,
  applicationId: ProviderApplicationProof.fields.applicationId,
  namespaceId: ProviderApplicationProof.fields.namespaceId,
  applicationVersion: ProviderApplicationProof.fields.applicationVersion,
  imageDigest: ProviderApplicationProof.fields.imageDigest,
  applicationConfigDigest: ProviderApplicationProof.fields.applicationConfigDigest,
});
export type ProviderObservationTarget = typeof ProviderObservationTarget.Type;
export const BoundProviderObservation = Schema.Struct({
  credentialBinding: Schema.Literal("POOL_PROVIDER_OBSERVATION_TOKEN"),
  proof: ProviderApplicationProof,
});

/** Credential acceptance must exercise the deployed Secret binding, without starting compute. */
export async function observeBoundProvider(
  token: ConstructorParameters<typeof RuntimeProviderReader>[0],
  target: ProviderObservationTarget,
  signal?: AbortSignal,
) {
  if (!token || typeof token !== "object") throw new ProviderObservationRefused();
  return Schema.decodeUnknownSync(BoundProviderObservation)({
    credentialBinding: "POOL_PROVIDER_OBSERVATION_TOKEN",
    proof: await new RuntimeProviderReader(token).observe(
      target,
      undefined,
      signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : undefined,
    ),
  });
}
