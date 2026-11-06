import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import { personalOrgFixture } from "./pool-personal-org-fixture.ts";

const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
const { provisioningFollowup } = await load(
  "apps/hosted/cloud/src/infrastructure/provisioning-followup.ts",
);
const { dispatchProvisioning } = await load("apps/hosted/cloud/src/infrastructure/provisioning.ts");
const { workflowResults } = await load("apps/hosted/cloud/src/infrastructure/workflow-results.ts");
const { GroupDatabase } = await load("apps/hosted/server/src/contracts/groups.ts");
const { WorkerEnvironment } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntime.js", import.meta.url)
    .href
);
const { WorkflowStep } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workflows/WorkflowRuntime.js", import.meta.url)
    .href
);

type Step = {
  readonly name: string;
  readonly effect: Effect.Effect<unknown, unknown>;
  readonly retries?: {
    readonly limit: number;
    readonly delay: string | number;
    readonly backoff?: string;
  };
};

for (const encrypted of [false, true]) {
  test(`a committed personal team dispatches without cron and shares recovery claims (encrypted=${encrypted})`, async () => {
    await personalOrgFixture(({ sql, guest, accept, jobs, work }) =>
      Effect.gen(function* () {
        // Start at the native accepted-invitation event, with no unrelated fixture jobs.
        yield* sql`delete from hosted_provisioning`;
        yield* accept();
        const [member] = yield* jobs();
        assert.ok(member);
        yield* work(member.id);
        const [personal] =
          yield* sql`select o.id from organization o join member m on m."organizationId" = o.id
          where m."userId" = ${guest.id} and m.role = 'owner'`;
        assert.ok(personal, "the member workflow committed its personal organization");
        const pending =
          yield* sql`select id from hosted_provisioning where status = 'queued' order by id`;
        const team = `team-${personal.id}`;
        assert.ok(pending.some((job: { id: string }) => job.id === team));

        const instances = new Map<string, unknown>();
        const creates: string[] = [];
        const gets: string[] = [];
        const installs: string[] = [];
        let unavailable = false;
        const binding = {
          create: async ({ id, params }: { id: string; params: unknown }) => {
            creates.push(id);
            if (unavailable) throw new TypeError("Network connection lost.");
            if (instances.has(id)) throw new Error("Instance already exists");
            instances.set(id, params);
            return {};
          },
          get: async (id: string) => {
            gets.push(id);
            if (!instances.has(id)) throw new Error("Instance not found");
            return { status: async () => ({ status: "running" }) };
          },
        };
        const dispatch = (immediate: boolean) =>
          dispatchProvisioning((id: string) =>
            Effect.sync(() => {
              if (immediate) installs.push(id);
            }),
          ).pipe(
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
            Effect.provideService(WorkerEnvironment, { Provisioning: binding }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({
                env: { EXECUTOR_ENCRYPTED_WORKFLOW_STARTS: String(encrypted) },
              }),
            ),
          );
        const journal = new Map<string, unknown>();
        const options: Step[] = [];
        const step = {
          do: (input: Step) =>
            Effect.suspend(() => {
              options.push(input);
              return journal.has(input.name)
                ? Effect.succeed(journal.get(input.name))
                : input.effect.pipe(
                    Effect.tap((value) => Effect.sync(() => journal.set(input.name, value))),
                  );
            }),
        };
        const requests: string[] = [];
        const followup = () =>
          Effect.gen(function* () {
            const results = encrypted
              ? yield* workflowResults(
                  "committed-member",
                  Effect.succeed(Redacted.make("31".repeat(32))),
                )
              : undefined;
            yield* provisioningFollowup({
              id: member.id,
              results,
              request: (job: string) =>
                Effect.gen(function* () {
                  requests.push(job);
                  // The wake crosses the host boundary only after the original transaction committed.
                  const [committed] =
                    yield* sql`select status from hosted_provisioning where id = ${member.id}`;
                  assert.equal(committed.status, "succeeded");
                  if (job === "provisioning") yield* dispatch(false);
                }),
            }).pipe(Effect.provideService(WorkflowStep, step));
          });
        yield* followup();
        assert.ok(instances.has(team), "the committed team must dispatch before any cron tick");
        assert.equal(instances.size, pending.length);
        assert.deepEqual(requests, ["provisioning", "schedule-wake"]);
        assert.equal(options.length, 2);
        assert.ok(
          options.every(
            (entry) => entry.retries?.limit === 5 && entry.retries.delay === "2 seconds",
          ),
        );
        const submitted = [...creates];
        yield* Effect.all([followup(), dispatch(false)], { concurrency: 2 });
        assert.deepEqual(creates, submitted, "replay and cron cannot reclaim a leased job");
        assert.deepEqual(
          installs,
          [],
          "workflow and cron dispatch leave installation to the durable workflow",
        );

        for (const job of pending) {
          yield* work(job.id);
          const before =
            yield* sql`select status, attempts from hosted_provisioning where id = ${job.id}`;
          assert.equal(before[0].status, "succeeded");
          yield* work(job.id);
          assert.deepEqual(
            yield* sql`select status, attempts from hosted_provisioning where id = ${job.id}`,
            before,
            "a repeated durable run cannot rerun committed provisioning",
          );
        }

        // A failed dispatch leaves the existing short lease, and cron can recover it when due.
        const missed = "missed-after-commit";
        yield* sql`insert into hosted_provisioning (id, kind, organization_id) values (${missed}, 'team', ${personal.id})`;
        unavailable = true;
        yield* dispatch(false);
        const [leased] =
          yield* sql`select status, available_at > now() as leased from hosted_provisioning where id = ${missed}`;
        assert.deepEqual(leased, { status: "queued", leased: true });
        assert.equal(instances.has(missed), false);
        unavailable = false;
        yield* sql`update hosted_provisioning set available_at = now() where id = ${missed}`;
        yield* Effect.all([dispatch(false), dispatch(true)], { concurrency: 2 });
        assert.equal(instances.has(missed), true, "cron recovers a lost workflow dispatch");
        assert.equal(
          creates.filter((id) => id === missed).length,
          2,
          "one failed create and one concurrent winner",
        );
        assert.ok(installs.length <= 1);

        // Losing the create response also recovers the same instance, rather than starting another.
        const total = instances.size;
        yield* sql`update hosted_provisioning set status = 'queued', available_at = now() where id = ${missed}`;
        yield* dispatch(false);
        assert.equal(instances.size, total);
        assert.ok(gets.includes(missed));
        assert.equal(
          (yield* sql`select status from hosted_provisioning where id = ${missed}`)[0].status,
          "running",
        );
      }),
    );
  });
}
