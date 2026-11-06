import assert from "node:assert/strict";
import { test } from "node:test";

const { Effect } = (await import(
  new URL("../../.upstream/node_modules/effect/dist/index.js", import.meta.url).href
)) as typeof import("../../.upstream/node_modules/effect/dist/index.js");
const { appProviderFailure } = (await import(
  new URL("../../.upstream/packages/sdk/src/implementation/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/provider-error.ts");
const { ProviderError } = (await import(
  new URL("../../.upstream/packages/apps/src/contracts/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/apps/src/contracts/provider-error.ts");
const { StorageError, AccountId } = (await import(
  new URL("../../.upstream/packages/sdk/src/contracts/shared.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts");

type Dependencies = Parameters<typeof appProviderFailure>[0];
type State = Parameters<ReturnType<typeof appProviderFailure>>[0];
const accountId = AccountId.make("acc_lookup");
const state = (identified: boolean) =>
  ({
    app: { id: "app_lookup" },
    version: { id: "dpl_lookup" },
    selections: [
      {
        required: { definition: { name: "Example", auth: { key: { type: "secrets" } } } },
        accounts: [
          {
            id: accountId,
            owner: "local",
            provider: "prv_lookup",
            method: "key",
            label: "Default 2",
            identityId: identified ? "aid_lookup" : null,
          },
        ],
      },
    ],
  }) as unknown as State;

for (const fault of ["placement", "query", "decode", "health", "defect"] as const) {
  test(`${fault} lookup failure preserves the provider refusal and renewal recovery`, async () => {
    const db = {
      findFirst: () => (fault === "query" ? Effect.fail(new StorageError()) : Effect.succeed({})),
    } as unknown as Dependencies["db"];
    const lifecycle =
      fault === "placement"
        ? ({
            accountIdentityPlacement: () => Effect.fail(new StorageError()),
          } as unknown as Dependencies["lifecycle"])
        : undefined;
    for (const renewal of ["renewed", new StorageError()] as const) {
      const error = await Effect.runPromise(
        Effect.flip(
          appProviderFailure({
            db,
            lifecycle,
            readHealth: () =>
              fault === "defect" ? Effect.die("lookup defect") : Effect.fail(new StorageError()),
          })(
            state(fault !== "health" && fault !== "defect"),
            new ProviderError({
              reason: "unauthorized",
              status: 401,
              accountId,
              phase: "call",
              upstream: { code: "expired", message: "Credential expired" },
            }),
            renewal,
          ),
        ),
      );
      assert.equal(error._tag, "AppProviderFailed");
      assert.ok(error._tag === "AppProviderFailed");
      assert.equal(error.reason, "unauthorized");
      assert.equal(error.status, 401);
      assert.equal(error.phase, "call");
      assert.deepEqual(error.upstream, { code: "expired", message: "Credential expired" });
      assert.equal(error.account?.label, "Example account 2");
      assert.equal(error.credentialsRenewed, renewal === "renewed" ? true : undefined);
      assert.deepEqual(error.renewalFailure, renewal === "renewed" ? undefined : renewal);
      assert.ok(error.recovery);
    }
  });
}

test("a failed hosted visibility lookup keeps the refusal without revealing a copied identity label", async () => {
  const input = state(false);
  const account = { ...input.selections[0]!.accounts[0]!, label: "owner@company.test" };
  const hidden = { ...input, selections: [{ ...input.selections[0]!, accounts: [account] }] };
  const result = await Effect.runPromise(
    Effect.flip(
      appProviderFailure({
        db: {} as Dependencies["db"],
        lifecycle: {
          accountFailureTitle: () => Effect.fail(new StorageError()),
        } as unknown as Dependencies["lifecycle"],
        readHealth: () => Effect.die("local reader must not run for a hosted failure"),
      })(hidden, new ProviderError({ reason: "forbidden", status: 403, accountId })),
    ),
  );
  assert.ok(result._tag === "AppProviderFailed");
  assert.equal(result.reason, "forbidden");
  assert.equal(result.status, 403);
  assert.equal(result.account?.label, "Example account");
  assert.ok(!JSON.stringify(result).includes("owner@company.test"));
});
