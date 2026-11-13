import * as Accounts from "@distilled.cloud/cloudflare/accounts";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import type * as Plan from "alchemy/Plan";
import { Effect, Stream } from "effect";
import { applyObservationToken } from "./observation-token-apply.ts";
import { observationTokenNative } from "./observation-token-native.ts";
import {
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import type { ObservationTokenProvider } from "./observation-token-provision.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

type Services = Effect.Services<
  ReturnType<typeof applyObservationToken> | ReturnType<typeof Accounts.getToken>
>;

export const observationTokenProvider = (input: {
  manifest: ObservationTokenManifest;
  enable: ProvisioningEnable | undefined;
  plan: Plan.Plan;
  now?: () => number;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Services>();
    const run = Effect.runPromiseWith(context);
    const { manifest } = input;
    const provider: ObservationTokenProvider = {
      absent: async () => {
        const rows = await run(
          Accounts.listTokens
            .items({ accountId: manifest.accountId })
            .pipe(Stream.runCollect, Retry.none),
        );
        return !rows.some((row) => row.name === observationTokenProps(manifest).name);
      },
      create: () =>
        run(applyObservationToken(input.plan, manifest, input.enable, input.now ?? Date.now)),
      native: () => run(observationTokenNative(manifest)),
      read: async (tokenId) => {
        const row = await run(
          Accounts.getToken({ accountId: manifest.accountId, tokenId }).pipe(Retry.none),
        );
        sameProvisioningValue("observationToken.readback.identity", tokenId, row.id);
        if (row.condition || row.expiresOn || row.notBefore)
          throw provisioningRefusal(
            "observation-token-readback-drift",
            "observationToken.validity",
            "unrestricted-validity",
            "changed",
          );
        return {
          accountId: manifest.accountId,
          name: row.name ?? "",
          status: row.status ?? "",
          policies: row.policies?.map((policy) => ({
            effect: policy.effect,
            permissionGroups: policy.permissionGroups?.map((group) => ({ id: group.id })),
            resources: policy.resources,
          })),
        };
      },
    };
    return provider;
  });
