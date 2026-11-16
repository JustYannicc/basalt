import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Effect, Redacted } from "effect";
import { canonical, digest } from "./manifest.ts";
import {
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

export const observationTokenFqn = "PoolProviderObservationToken";
export const observationTokenType = "Cloudflare.ApiToken.AccountApiToken";

/** The native resource retains the Redacted value; this projection never returns it. */
export const observationTokenNative = (manifest: ObservationTokenManifest) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const row = yield* state.get({
      stack: manifest.stack,
      stage: manifest.stage,
      fqn: observationTokenFqn,
    });
    if (row?.status !== "created")
      throw provisioningRefusal(
        "observation-token-native-result-unconfirmed",
        "observationToken.native.status",
        "created",
        row?.status ?? null,
      );
    sameProvisioningValue(
      "observationToken.native.identity",
      {
        status: "created",
        fqn: observationTokenFqn,
        logicalId: observationTokenFqn,
        resourceType: observationTokenType,
        instanceId: manifest.instanceId,
        removalPolicy: "retain",
        props: observationTokenProps(manifest),
      },
      row && {
        status: row.status,
        fqn: row.fqn,
        logicalId: row.logicalId,
        resourceType: row.resourceType,
        instanceId: row.instanceId,
        removalPolicy: row.removalPolicy,
        props: row.props,
      },
    );
    const attributes = row?.attr;
    if (
      !attributes ||
      typeof attributes !== "object" ||
      !("value" in attributes) ||
      !Redacted.isRedacted(attributes.value) ||
      typeof Redacted.value(attributes.value) !== "string" ||
      Redacted.value(attributes.value) === "" ||
      !("tokenId" in attributes) ||
      typeof attributes.tokenId !== "string" ||
      !attributes.tokenId ||
      !("status" in attributes) ||
      attributes.status !== "active" ||
      !("accountId" in attributes) ||
      attributes.accountId !== manifest.accountId ||
      !("name" in attributes) ||
      attributes.name !== observationTokenProps(manifest).name
    )
      throw provisioningRefusal(
        "observation-token-native-result-unconfirmed",
        "observationToken.native",
        "created-active-scoped-with-redacted-value",
        row?.status ?? null,
      );
    return { tokenId: attributes.tokenId, nativeDigest: digest(canonical(encodeState(row!))) };
  });
