import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  definition,
  owner,
  visibilityFixture,
  CurrentAuthorization,
  fullAuthority,
} from "./provider-error-visibility-fixture.ts";

const root = new URL("../../.upstream/", import.meta.url);
const { appProviderFailure } = (await import(
  new URL("packages/sdk/src/implementation/provider-error.ts", root).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/provider-error.ts");
const { ProviderError } = (await import(
  new URL("packages/apps/src/contracts/provider-error.ts", root).href
)) as typeof import("../../.upstream/packages/apps/src/contracts/provider-error.ts");
const { accountTitle, accountKindLabel } = (await import(
  new URL("packages/ui/src/contracts/account-identities.ts", root).href
)) as typeof import("../../.upstream/packages/ui/src/contracts/account-identities.ts");
const { CurrentActor } = (await import(
  new URL("packages/sdk/src/contracts/executor.ts", root).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/executor.ts");
const { diagnostic, diagnosticSummary } = (await import(
  new URL("packages/mcp/src/implementation/diagnostics.ts", root).href
)) as typeof import("../../.upstream/packages/mcp/src/implementation/diagnostics.ts");
const { describeAppFailure, renderAppFailure } = (await import(
  new URL("packages/app-management/src/cli.ts", root).href
)) as typeof import("../../.upstream/packages/app-management/src/cli.ts");

type Dependencies = Parameters<typeof appProviderFailure>[0];
type State = Parameters<ReturnType<typeof appProviderFailure>>[0];
for (const [verified, label, editor] of [
  [false, "Default 2", false],
  [true, "Default 2", false],
  [false, "owner@company.test", false],
  [false, "Default 2", true],
] as const) {
  test(`hosted member and owner errors equal their own shared-account row titles, verified=${verified}, label=${label}, editor=${editor}`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* visibilityFixture(verified, label, editor);
          const db = {
            findFirst: () => Effect.succeed(fixture.account.identity),
          } as unknown as Dependencies["db"];
          for (const actor of ["member", "owner"] as const) {
            const row = yield* fixture.row(actor);
            const summary = {
              ...row.account,
              providerName: definition.name,
              health: row.health,
            } as Parameters<typeof accountKindLabel>[1];
            const inventory = {
              apps: [
                {
                  requirements: {
                    accounts: { service: { provider: row.account.provider, definition } },
                  },
                },
              ],
            } as unknown as Parameters<typeof accountKindLabel>[0];
            const title = accountTitle(summary, undefined, accountKindLabel(inventory, summary));
            assert.equal(
              title,
              actor === "owner" || editor
                ? verified
                  ? "Verified Owner"
                  : label === "Default 2"
                    ? "owner@company.test"
                    : label
                : label === "Default 2"
                  ? "Example account 2"
                  : "Connected account",
            );
            const state = {
              app: { id: "app_visibility", owner },
              version: { id: "dpl_visibility" },
              actor,
              selections: [
                {
                  required: { definition },
                  accounts: [
                    { ...fixture.account, identityId: verified ? "aid_visibility" : null },
                  ],
                },
              ],
            } as unknown as State;
            const failure = yield* Effect.flip(
              appProviderFailure({
                db,
                lifecycle: fixture.hooks,
                readHealth: () => Effect.succeed(fixture.health),
              })(
                state,
                new ProviderError({
                  reason: "forbidden",
                  status: 403,
                  accountId: fixture.account.id,
                }),
              ),
            ).pipe(Effect.provideService(CurrentActor, actor === "member" ? "owner" : "member"));
            assert.ok(failure._tag === "AppProviderFailed");
            assert.equal(failure.account?.label, title);
            const described = describeAppFailure(failure);
            assert.ok(described);
            const outputs = [
              failure.description,
              failure.account?.label,
              JSON.stringify(failure),
              diagnostic(failure, { operation: "call", reference: undefined }),
              diagnosticSummary(failure, { operation: "call", reference: undefined }),
              renderAppFailure(described),
            ];
            for (const output of outputs) {
              assert.ok(output?.includes(title));
              if (actor === "member" && !editor) {
                assert.ok(!output.includes("owner@company.test"));
                assert.ok(!output.includes("Verified Owner"));
              }
            }
          }
        }),
      ).pipe(
        Effect.provideService(CurrentAuthorization, fullAuthority),
        Effect.provide(pgliteLayer()),
      ),
    );
  });
}
