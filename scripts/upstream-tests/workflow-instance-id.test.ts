import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Logger } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
const { workflowInstanceId, dispatchFailureReason }: {
  workflowInstanceId: (id: string) => Promise<string>;
  dispatchFailureReason: (cause: unknown) => { name: string; message: string };
} = await load("apps/hosted/cloud/src/contracts/workflow-instance-id.ts");
const { workflowResultInput } = await load("apps/hosted/cloud/src/infrastructure/workflow-results.ts");
const { dispatchProvisioning } = await load("apps/hosted/cloud/src/infrastructure/provisioning.ts");
const { GroupDatabase } = await load("apps/hosted/server/src/contracts/groups.ts");
const { WorkerEnvironment } = await import(new URL("../../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntime.js", import.meta.url).href);
const { catalogAppJobPrefix } = await load("apps/hosted/server/src/contracts/catalog-app-updates.ts");
const { poolRotationJobPrefix } = await load("apps/hosted/server/src/contracts/pool-defaults.ts");
const uuid = "00000000-0000-4000-8000-000000000001";
const catalogJob = `${catalogAppJobPrefix}${"a".repeat(40)}:${uuid}`;
const departureJob = `contributed-departure-${uuid}`;
const poolJob = `${poolRotationJobPrefix}${"b".repeat(64)}:${uuid}`;
const valid = (id: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(id) && id.length <= 100 && !/[\r\n]/.test(id);

test("every provisioning producer's job shape maps to a stable, distinct Cloudflare ID", async () => {
  // UUID defaults serve billing, domain, member, executor-app and pool-upgrade jobs.
  const jobs = [uuid, `team-${uuid}`, `user-${uuid}`, catalogJob, poolJob];
  const instances = await Promise.all(jobs.map(workflowInstanceId));
  for (const [index, instance] of instances.entries()) {
    assert.ok(valid(instance), jobs[index]);
    assert.equal(instance, await workflowInstanceId(jobs[index]));
  }
  assert.equal(new Set(instances).size, jobs.length);
  assert.equal(instances[0], uuid, "existing UUID instances must keep their identity");
  assert.equal(instances[1], jobs[1]);
  assert.equal(instances[2], jobs[2]);
});

test("arbitrary IDs cannot alias the reserved digest namespace", async () => {
  const jobs = ["", "-leading", "with spaces", "line\n", "line\r", "😺", "x".repeat(101), "x".repeat(10000), "a:b", "a/b", "a_b"];
  const instances = await Promise.all(jobs.map(workflowInstanceId));
  assert.ok(instances.every(valid));
  assert.equal(new Set(instances).size, jobs.length);
  const digest = await workflowInstanceId(catalogJob);
  assert.equal(digest.length, 68);
  assert.notEqual(await workflowInstanceId(digest), digest);
});

test("dispatch errors log only recognized names and closed diagnostic messages", () => {
  assert.deepEqual(dispatchFailureReason(new TypeError("Network connection lost.")), {
    name: "TypeError", message: "Network connection lost.",
  });
  assert.deepEqual(dispatchFailureReason(new Error("Invalid instance ID: private-job")), {
    name: "Error", message: "Invalid Workflow instance ID",
  });
  const secret = "private-content Bearer secret-token https://private.invalid/?token=secret";
  const error = new Error(secret);
  error.name = secret;
  for (const cause of [error, { _tag: secret, message: secret }, secret, { _tag: "SqlError", cause: secret }]) {
    assert.doesNotMatch(JSON.stringify(dispatchFailureReason(cause)), /private|secret|Bearer/);
  }
});

for (const encrypted of [false, true]) test(`retained colon jobs dispatch and recover with original handler IDs (encrypted=${encrypted})`, async () => {
  const calls: { id: string; params: unknown }[] = [];
  const gets: string[] = [];
  const installs: string[] = [];
  const logs: unknown[] = [];
  const capture = Logger.make((options) => logs.push(options.message));
  let failCreate = false;
  let failGet = false;
  const binding = {
    create: async (options: { id: string; params: unknown }) => {
      assert.ok(valid(options.id), "Cloudflare rejects invalid instance IDs");
      calls.push(options);
      if (failCreate) throw new TypeError("Network connection lost.");
      return {};
    },
    get: async (id: string) => {
      assert.ok(valid(id));
      gets.push(id);
      if (failGet) throw new Error("private lookup failure");
      return { status: async () => ({ status: "complete" }) };
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table hosted_provisioning (
        id text primary key, kind text not null, status text not null default 'queued',
        available_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
      yield* sql`insert into hosted_provisioning (id, kind) values (${catalogJob}, 'member'), (${poolJob}, 'member'), (${`team-${uuid}`}, 'team')`;
      yield* sql`create table hosted_contributed_departure_jobs (id text primary key, status text not null default 'queued')`;
      yield* sql`insert into hosted_contributed_departure_jobs (id) values (${departureJob})`;
      const dispatch = dispatchProvisioning((job: string) => Effect.sync(() => { installs.push(job); })).pipe(
        Effect.provideService(GroupDatabase, Effect.succeed(sql)),
        Effect.provideService(WorkerEnvironment, { Provisioning: binding }),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({
          env: { EXECUTOR_ENCRYPTED_WORKFLOW_STARTS: String(encrypted) },
        })),
        Effect.provide(Logger.layer([capture])),
      );
      yield* dispatch;
      for (const job of [catalogJob, poolJob]) {
        const instance = yield* Effect.promise(() => workflowInstanceId(job));
        const request = yield* workflowResultInput(calls.find((call) => call.id === instance)?.params);
        assert.deepEqual(request.params, { id: job }, "the handler receives the original job ID");
        assert.equal(request.mode, encrypted ? "encrypted" : "legacy");
      }
      assert.equal(calls.length, 3, "departures never enter provisioning workflows");
      assert.equal((yield* sql`select status from hosted_contributed_departure_jobs where id = ${departureJob}`)[0].status, "queued");
      assert.deepEqual(installs, [`team-${uuid}`]);
      const [running] = yield* sql`select id, status from hosted_provisioning where id = ${catalogJob}`;
      assert.deepEqual(running, { id: catalogJob, status: "running" });
      // Simulate a lost create response followed by a retry of the original row.
      yield* sql`update hosted_provisioning set status = 'queued', available_at = now() where id = ${catalogJob}`;
      failCreate = true;
      yield* dispatch;
      assert.equal(gets[0], yield* Effect.promise(() => workflowInstanceId(catalogJob)));
      const [finished] = yield* sql`select id, status from hosted_provisioning where id = ${catalogJob}`;
      assert.deepEqual(finished, { id: catalogJob, status: "succeeded" });
      yield* sql`update hosted_provisioning set status = 'queued', available_at = now() where id = ${catalogJob}`;
      failGet = true;
      yield* dispatch;
      assert.match(JSON.stringify(logs), /Network connection lost/);
      assert.doesNotMatch(JSON.stringify(logs), /private lookup failure/);
      const [retry] = yield* sql`select status from hosted_provisioning where id = ${catalogJob}`;
      assert.equal(retry.status, "queued");
    }).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<unknown, unknown>,
  );
});
