import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { provisioningJournal, type ProvisioningStore } from "./provisioning-journal.ts";
import {
  assertObservationTokenEnable,
  decodeObservationTokenManifest,
  observationTokenDigest,
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { decodeProvisioningInput, sameProvisioningValue } from "./provisioning-refusal.ts";

const Created = Schema.Struct({
  tokenId: Schema.NonEmptyString,
  nativeDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export interface ObservationTokenProvider {
  absent(): Promise<boolean>;
  create(): Promise<typeof Created.Type>;
  read(
    tokenId: string,
  ): Promise<{ accountId: string; name: string; status: string; policies: unknown }>;
  native(): Promise<typeof Created.Type>;
}

/** Journal receipts contain identity and hashes, never the secret returned to the SDK. */
export async function provisionObservationToken(
  input: ObservationTokenManifest,
  enable: ProvisioningEnable | undefined,
  store: ProvisioningStore,
  provider: ObservationTokenProvider,
  now = Date.now,
) {
  const manifest = structuredClone(decodeObservationTokenManifest(input));
  const enabled = () => {
    assertObservationTokenEnable(manifest, enable, now());
    sameProvisioningValue(
      "observationToken.manifest",
      observationTokenDigest(manifest),
      observationTokenDigest(input),
    );
  };
  enabled();
  const journal = provisioningJournal(
    store,
    manifest.candidate,
    observationTokenDigest(manifest),
    "PoolProviderObservationToken",
  );
  const created = await journal.once(
    "token-create",
    digest(canonical(observationTokenProps(manifest))),
    async () => {
      enabled();
      sameProvisioningValue("observationToken.absent", true, await provider.absent());
      enabled();
      return provider.create();
    },
    decodeProvisioningInput(Created, "observationToken.created"),
  );
  const props = observationTokenProps(manifest);
  sameProvisioningValue(
    "observationToken.readback",
    { accountId: manifest.accountId, name: props.name, status: "active", policies: props.policies },
    await provider.read(created.tokenId),
  );
  sameProvisioningValue("observationToken.native", created, await provider.native());
  const receipt = {
    format: "pool-observation-token-receipt-v1",
    candidate: manifest.candidate,
    manifest: observationTokenDigest(manifest),
    accountId: manifest.accountId,
    tokenId: created.tokenId,
    nativeDigest: created.nativeDigest,
  };
  await journal.finish(digest(canonical(receipt)));
  return receipt;
}
