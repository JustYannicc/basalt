import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Verify activation retains the original refs when adding only the machine method. */
export async function assertProviderContinuity(root, original, requirements) {
  const sdk = join(root, ".upstream/packages/sdk/src");
  const requireSdk = createRequire(join(root, ".upstream/packages/sdk/package.json"));
  const load = (path) => import(pathToFileURL(path).href);
  const { Crypto, Effect } = await load(requireSdk.resolve("effect"));
  const NodeCrypto = await load(requireSdk.resolve("@effect/platform-node/NodeCrypto"));
  // This directly proves the activation selector, not a persisted deployment/database migration.
  const { identifyProvider } = await load(join(sdk, "implementation/provider.ts"));
  const { chooseProviderIds } = await load(join(sdk, "implementation/provider-continuity.ts"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const entries = [];
      const previous = {};
      for (const slot of ["plaid", "plaidMcp"]) {
        const before = yield* identifyProvider(original.accounts.user[slot].definition, crypto);
        const after = yield* identifyProvider(requirements.accounts.user[slot].definition, crypto);
        if (slot === "plaidMcp")
          assert.notEqual(
            after.identity,
            before.identity,
            "Adding a method changes the content identity",
          );
        else assert.equal(after.identity, before.identity);
        entries.push({ slot, provider: after });
        previous[slot] = {
          ...original.accounts.user[slot],
          scope: "user",
          provider: `prv_retained_${slot}`,
        };
      }
      const db = {
        findMany: () => {
          throw new Error("Exact/additive continuity must not need a legacy database lookup");
        },
      };
      const chosen = yield* chooseProviderIds(db, crypto, entries, previous);
      assert.deepEqual(
        chosen.map((entry) => [entry.slot, entry.provider.id]),
        [
          ["plaid", "prv_retained_plaid"],
          ["plaidMcp", "prv_retained_plaidMcp"],
        ],
      );
      assert.ok(chosen.every((entry) => entry.provider.allowAdditionalStoredMethods));
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
}
