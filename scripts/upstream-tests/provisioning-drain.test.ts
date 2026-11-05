import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
const { dispatchProvisioning } = await load("apps/hosted/cloud/src/infrastructure/provisioning.ts");
const { GroupDatabase } = await load("apps/hosted/server/src/contracts/groups.ts");
const { WorkerEnvironment } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntime.js", import.meta.url)
    .href
);

for (const scenario of ["backlog", "enqueue-during-dispatch", "dispatch-failure"] as const)
  test(`one provisioning kick drains runnable jobs: ${scenario}`, async () => {
    const started: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table hosted_provisioning (
          id text primary key, kind text not null, status text not null default 'queued',
          available_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
        const count = scenario === "enqueue-during-dispatch" ? 1 : 51;
        yield* sql`insert into hosted_provisioning (id, kind)
          select 'initial-' || n, 'member' from generate_series(1, ${count}::int) n`;
        yield* sql`insert into hosted_provisioning (id, kind, available_at)
          values ('delayed', 'member', now() + interval '1 hour')`;
        const binding = {
          create: async ({ id }: { id: string }) => {
            started.push(id);
            if (scenario === "dispatch-failure" && id === "initial-1")
              throw new TypeError("Network connection lost.");
            if (scenario === "enqueue-during-dispatch" && id === "initial-1")
              await Effect.runPromise(sql`insert into hosted_provisioning (id, kind)
                values ('follow-up', 'team')`);
            return {};
          },
          get: async () => {
            throw new Error("unexpected lookup");
          },
        };
        yield* dispatchProvisioning(() => Effect.void).pipe(
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(WorkerEnvironment, { Provisioning: binding }),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { EXECUTOR_ENCRYPTED_WORKFLOW_STARTS: "false" },
            }),
          ),
        );
        const runnable = yield* sql`select id from hosted_provisioning
          where status = 'queued' and available_at <= now() order by id`;
        assert.deepEqual(runnable, [], "a kick must not strand runnable jobs until cron");
        assert.equal(started.length, count + (scenario === "enqueue-during-dispatch" ? 1 : 0));
        assert.equal(new Set(started).size, started.length, "each job starts once");
        if (scenario === "dispatch-failure") {
          const [retry] = yield* sql`select status, available_at > now() as deferred
            from hosted_provisioning where id = 'initial-1'`;
          assert.deepEqual(
            retry,
            { status: "queued", deferred: true },
            "failed dispatch keeps its retry lease",
          );
        }
        const [delayed] = yield* sql`select status from hosted_provisioning where id = 'delayed'`;
        assert.equal(delayed.status, "queued", "future retries stay deferred");
      }).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<unknown, unknown>,
    );
  });

const { provision, selfHostProvisioningServices } = await load(
  "apps/hosted/server/src/implementation/provisioning.ts",
);
const { migrateProvisioning } = await load(
  "apps/hosted/server/src/implementation/provisioning-schema.ts",
);
const { OrganizationDefaults, OrganizationDefaultsPending } = await load(
  "apps/hosted/server/src/contracts/organization-defaults.ts",
);

for (const pending of [false, true])
  test(`member follow-up waits for current defaults: pending=${pending}`, async () => {
    const steps: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table organization (id text primary key, slug text, metadata text)`;
        yield* sql`create table "user" (id text primary key, name text, "emailVerified" boolean)`;
        yield* sql`create table member ("organizationId" text, "userId" text, role text)`;
        yield* migrateProvisioning;
        yield* sql`insert into organization (id, slug) values ('current', 'current')`;
        yield* sql`insert into "user" (id, name, "emailVerified") values ('person', 'Person', true)`;
        yield* sql`insert into member ("organizationId", "userId", role)
          values ('current', 'person', 'owner')`;
        const [job] = yield* sql`select id from hosted_provisioning where kind = 'member'`;
        const work = (blocked: boolean) =>
          provision(job.id, {
            ...selfHostProvisioningServices,
            member: () =>
              Effect.sync(() => {
                steps.push("follow-up");
              }),
          }).pipe(
            Effect.provideService(OrganizationDefaults, () =>
              Effect.gen(function* () {
                steps.push("defaults");
                if (blocked) return yield* new OrganizationDefaultsPending();
                steps.push("ready");
              }),
            ),
          );
        if (pending) {
          assert.equal((yield* Effect.exit(work(true)))._tag, "Failure");
          assert.deepEqual(steps, ["defaults"], "pending setup must not start more team work");
          const [retry] = yield* sql`select status from hosted_provisioning where id = ${job.id}`;
          assert.equal(retry.status, "queued");
          steps.length = 0;
        }
        yield* work(false);
        assert.deepEqual(steps, ["defaults", "ready", "follow-up"]);
        yield* work(false);
        assert.deepEqual(steps, ["defaults", "ready", "follow-up"], "success stays idempotent");
      }).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<unknown, unknown>,
    );
  });
