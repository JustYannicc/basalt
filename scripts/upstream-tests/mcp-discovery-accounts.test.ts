import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { fixture } from "./app-linked-reads-fixture.ts";
import { HostedExecutor, sdk } from "./provider-destinations-modules.ts";
const { hostedMcpBackend } =
  await import("../../.upstream/apps/hosted/server/src/implementation/mcp.ts");

for (const saved of [48, 96])
  test(`MCP account discovery batches linked metadata, saved=${saved}`, async () => {
    await Effect.runPromise(
      fixture(
        ({ app, reads }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const backend = yield* hostedMcpBackend.pipe(
              Effect.provideService(
                HostedExecutor,
                Effect.succeed({
                  ...executor,
                  apps: { ...executor.apps, list: () => Effect.succeed([app]) },
                }),
              ),
            );
            const linked = yield* backend.listAccounts({ app: app.id });
            assert.equal(linked.own?.accounts.length, 4);
            assert.equal(
              reads.accountGet ?? 0,
              0,
              "search must not issue a metadata read per link",
            );
            assert.equal(reads.accountList, 1);
            assert.equal(reads.accountRows, 3, "unlinked accounts must not be read");
            yield* backend.listAccounts({ app: app.id });
            assert.equal(reads.accountList, 1, "discovery shares one request-owned snapshot");
          }),
        { count: saved },
      ),
    );
  });

for (const status of ["online", "offline", "unavailable", "disabled"] as const)
  test(`MCP discovery preserves the selected device target when ${status}`, async () => {
    await Effect.runPromise(
      fixture(({ app, saved }) =>
        Effect.gen(function* () {
          saved[0]!.execution = {
            kind: "device",
            device: "fixture-device",
            deviceName: "Fixture computer",
            status,
          };
          const executor = yield* Effect.flatten(HostedExecutor);
          const backend = yield* hostedMcpBackend.pipe(
            Effect.provideService(
              HostedExecutor,
              Effect.succeed({
                ...executor,
                apps: { ...executor.apps, list: () => Effect.succeed([app]) },
              }),
            ),
          );
          const linked = yield* backend.listAccounts({ app: app.id });
          assert.deepEqual(
            linked.own?.accounts.find((account) => account.id === saved[0]!.id)?.execution,
            saved[0]!.execution,
          );
        }),
      ),
    );
  });

test("an account removed during discovery is not described as a cloud account", async () => {
  await Effect.runPromise(
    fixture(({ app, saved }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(
            HostedExecutor,
            Effect.succeed({
              ...executor,
              apps: { ...executor.apps, list: () => Effect.succeed([app]) },
              [sdk.AccountReadHost]: {
                ...executor[sdk.AccountReadHost],
                listIds: (input) =>
                  executor[sdk.AccountReadHost]
                    .listIds(input)
                    .pipe(
                      Effect.map((accounts) =>
                        accounts.filter((account) => account.id !== saved[0]!.id),
                      ),
                    ),
              },
            }),
          ),
        );
        const linked = yield* backend.listAccounts({ app: app.id });
        assert.ok(!linked.own?.accounts.some((account) => account.id === saved[0]!.id));
      }),
    ),
  );
});

const { searchCatalog } =
  await import("../../.upstream/packages/mcp/src/implementation/execute.ts");
const { defaultMcpLimits } = await import("../../.upstream/packages/mcp/src/contracts/execute.ts");

for (const failure of ["failed", "stalled"] as const)
  test(`an empty search identifies a ${failure} catalog source`, { timeout: 20_000 }, async () => {
    await Effect.runPromise(
      fixture(({ app }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const backend = yield* hostedMcpBackend.pipe(
            Effect.provideService(
              HostedExecutor,
              Effect.succeed({
                ...executor,
                apps: { ...executor.apps, list: () => Effect.succeed([app]) },
              }),
            ),
          );
          const page = yield* searchCatalog(
            {
              ...backend,
              searchableTools: () =>
                failure === "stalled" ? Effect.never : Effect.fail(new sdk.StorageError()),
              searchTools: () => Effect.succeed({ items: [], remaining: 0, missing: [] }),
            },
            defaultMcpLimits,
            { query: "list calendars" },
          );
          assert.equal(page.items.length, 0);
          assert.ok(
            page.unavailableApps.some(
              (source) =>
                source.app === app.id &&
                source.reason.includes(
                  failure === "stalled" ? "AppDiscoveryTimedOut" : "StorageError",
                ),
            ),
            "a failed source is partial search, not a complete no-match result",
          );
        }),
      ),
    );
  });
