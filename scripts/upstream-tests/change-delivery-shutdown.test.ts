import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Deferred, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeHostedBackgroundWork } from "../../.upstream/apps/hosted/server/src/implementation/background-work.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";

const {
  lock,
}: typeof import("../../.upstream/apps/hosted/self-host/node_modules/@types/proper-lockfile/index.d.ts") =
  createRequire(new URL("../../.upstream/apps/hosted/self-host/package.json", import.meta.url))(
    "proper-lockfile",
  );

test(
  "pending deliveries stop within the process budget and restart with the same unlocked data",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "basalt-change-stop-"));
    const deliveryStarted = Deferred.makeUnsafe<void>();
    const dataDir = join(directory, "hosted.pglite");
    await mkdir(dataDir);
    let stopStarted = 0;
    const database = pgliteLayer({ dataDir });
    const stageLock = Effect.acquireRelease(
      Effect.promise(() => lock(dataDir, { retries: 0 })),
      (unlock: () => Promise<void>) => Effect.promise(() => unlock()),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* stageLock;
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
              yield* migrateChangeRevisions;
              for (let i = 0; i < 4; i++)
                yield* sql`insert into executor_apps values (${`app-${i}`}, 'organization:test', 'build')`;
              const background = yield* makeHostedBackgroundWork;
              yield* background(
                makeChangeJournal(sql)
                  .deliver(() =>
                    Deferred.succeed(deliveryStarted, undefined).pipe(Effect.andThen(Effect.never)),
                  )
                  .pipe(Effect.ignore),
              );
              yield* Deferred.await(deliveryStarted);
              stopStarted = performance.now();
            }).pipe(Effect.provide(database));
          }),
        ),
      );
      const elapsed = performance.now() - stopStarted;
      console.log(JSON.stringify({ stopMs: elapsed, stopBudgetMs: 15000 }));
      assert.ok(
        elapsed < 15000,
        `shutdown took ${elapsed}ms, exceeding the 15000ms process budget`,
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* stageLock;
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const sent: string[] = [];
              yield* makeChangeJournal(sql).deliver((_scope, hint) =>
                Effect.sync(() => {
                  sent.push(hint.resource);
                }),
              );
              assert.deepEqual(sent.sort(), ["app-0", "app-1", "app-2", "app-3"]);
              assert.deepEqual(yield* sql`select * from hosted_change_pending`, []);
            }).pipe(Effect.provide(pgliteLayer({ dataDir })));
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
