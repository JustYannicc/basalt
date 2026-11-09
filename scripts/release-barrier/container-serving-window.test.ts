import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { verifyServingContainer } from "./container-serving.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { handleDeploymentReadiness } from "../../src/pool/deployment-readiness.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { ServingFailure } from "./serving-failure.ts";
import { releaseEvidence } from "./evidence.ts";
import { refusalTable } from "./refusal-report.ts";
import { containerCodeAdoptionMs, waitForContainerCode } from "./container-adoption.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Recorded b301 milestones. Neither rollout completion nor the first RUNNING
// observation was retained. The fake supplies those observations; these dates
// describe the restart sequence, not a measured allocation deadline.
const epoch = Date.parse("2026-11-08T09:10:00.182Z");
const milestones = [
  "09:10:10.641",
  "09:10:13.842",
  "09:10:14.245",
  "09:10:21.042",
  "09:11:52.898",
  "09:12:06.391",
  "09:12:09.791",
  "09:12:10.303",
  "09:12:18.391",
].map((time) => Date.parse(`2026-11-08T${time}Z`));
const finalStart = milestones[4]!;
const finalReady = milestones[8]!;

function fixture(
  mode: "cycling" | "never-ready" | "never-allocated" | "adopting" | "old-runtime" = "cycling",
  runtimeDelayMs = 0,
) {
  let now = epoch;
  let startupAt = -1;
  const timers: { at: number; controller: AbortController }[] = [];
  const advanceTo = (at: number) => {
    now = at;
    for (const timer of timers) if (now >= timer.at) timer.controller.abort();
  };
  const clock = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      advanceTo(now + milliseconds);
    },
    deadline(milliseconds: number) {
      if (milliseconds === 180_000) startupAt = now;
      const timer = { at: now + milliseconds, controller: new AbortController() };
      timers.push(timer);
      return {
        signal: timer.controller.signal,
        dispose: () => {
          const index = timers.indexOf(timer);
          if (index !== -1) timers.splice(index, 1);
        },
      };
    },
  };
  const proof = containerPublication();
  const candidate = "a".repeat(40);
  const key = "b".repeat(64);
  const instanceId = "c".repeat(64);
  const target = { candidate, workerInput: poolWorkerRevision, imageHash: proof.frozen.inputHash };
  let healthReads = 0;
  let readyRequests = 0;
  const connect = async () => ({
    env: {
      POOL_OPERATIONS: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === "/deployment-readiness") {
            return handleDeploymentReadiness(request, target, key, async (phase) => {
              if (phase === "adoption")
                return {
                  ...target,
                  candidate:
                    mode === "old-runtime" || (mode === "adopting" && now < epoch + 300_000)
                      ? "e".repeat(40)
                      : candidate,
                  instanceId,
                };
              readyRequests++;
              if (mode === "adopting" || mode === "old-runtime") {
                if (now < epoch + 300_000 + runtimeDelayMs)
                  throw new Error("Synthetic startup in progress after adoption");
                return {
                  ...target,
                  candidate:
                    mode === "old-runtime" || now < epoch + 300_000 ? "e".repeat(40) : candidate,
                  desiredRevisionMatch: true,
                  instanceId,
                  bootId: "final-boot",
                  readyAt: now,
                };
              }
              if (mode !== "cycling") throw new Error("Synthetic runtime remains unready");
              if (readyRequests === 1) for (const at of milestones.slice(0, 4)) advanceTo(at);
              if (now >= finalStart && now < finalReady)
                throw new Error("Synthetic startup in progress");
              return {
                ...target,
                desiredRevisionMatch: true,
                instanceId,
                bootId: now >= finalReady ? "final-boot" : "first-boot",
                readyAt: now,
              };
            });
          }
          if (++healthReads === 1 && mode === "cycling") advanceTo(finalStart);
          return Response.json({
            instanceId,
            imageHash: target.imageHash,
            running: true,
            ready: mode === "adopting" || (mode === "cycling" && now >= finalReady),
            bootId: "final-boot",
          });
        },
      },
    },
    dispose: async () => {},
  });
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const path = new URL(String(input)).pathname;
    if (path === "/health") return new Response(null, { status: 200 });
    if (path === "/v1/models") return new Response(null, { status: 401 });
    const result = path.endsWith("/instances-v2")
      ? mode === "never-allocated"
        ? []
        : [
            {
              id: instanceId,
              application_id: "pool-app",
              image: proof.proposed.configuration.image,
              ...(now >= finalStart ? { started_at: new Date(finalStart).toISOString() } : {}),
              status: { state: "running" },
            },
          ]
      : {
          id: "pool-app",
          account_id: "fixture",
          version: 2,
          configuration: proof.proposed.configuration,
        };
    return Response.json({ success: true, errors: [], result, result_info: {} });
  };
  const run = () =>
    Effect.runPromise(
      verifyServingContainer(
        proof.frozen,
        { worker: "PoolWorker", accountId: "fixture", connect },
        candidate,
        fetcher,
        { clock, applicationVersion: 2 },
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                CLOUDFLARE_API_TOKEN: "synthetic-never-sent",
                POOL_DEPLOYMENT_KEY: key,
              },
            }),
          ),
        ),
      ),
    );
  return {
    run,
    clock,
    get now() {
      return now;
    },
    get startupAt() {
      return startupAt;
    },
  };
}

async function atClock<A>(f: ReturnType<typeof fixture>, work: () => Promise<A>) {
  const originalNow = Date.now;
  Date.now = f.clock.now;
  try {
    return await work();
  } finally {
    Date.now = originalNow;
  }
}

test("recorded b301 restart milestones reestablish the final boot inside unchanged bounds", async () => {
  const f = fixture();
  const result = await atClock(f, f.run);
  assert.equal(result.bootId, "final-boot");
  assert.ok(f.now >= finalReady);
  assert.ok(f.now - f.startupAt < 180_000);
});

test("a newly activated entrypoint waits for the old Durable Object to adopt the target", async () => {
  const f = fixture("adopting");
  const result = await atClock(f, f.run);
  assert.equal(result.bootId, "final-boot");
  assert.equal(f.now - epoch, 300_000);
  assert.ok(f.now - f.startupAt < 180_000);
});

test("runtime startup retains its own budget after the full deferred code adoption", async () => {
  const f = fixture("adopting", 150_000);
  const result = await atClock(f, f.run);
  assert.equal(result.bootId, "final-boot");
  assert.equal(f.startupAt, epoch + 300_000);
  assert.equal(f.now - f.startupAt, 150_000);
});

test("a stalled old adapter cannot hide the next code observation", async () => {
  const f = fixture();
  const expected = {
    candidate: "a".repeat(40),
    workerInput: "b".repeat(64),
    imageHash: "c".repeat(16),
  };
  let requests = 0;
  await waitForContainerCode(
    {
      async adoption() {
        if (++requests === 1) {
          await f.clock.sleep(10_000);
          return new Promise(() => {});
        }
        return { adopted: true, observed: { ...expected, instanceId: "d".repeat(64) } };
      },
    },
    expected,
    f.clock,
    epoch + containerCodeAdoptionMs,
    new AbortController().signal,
  );
  assert.equal(requests, 2);
  assert.equal(f.now - epoch, 15_000);
});

test("a Durable Object that never adopts refuses with the old and expected identity", async () => {
  const f = fixture("old-runtime");
  await atClock(f, async () =>
    assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof ServingFailure);
      assert.equal(error.serving.check, "code-adoption");
      assert.equal(error.serving.cause, "identity-deadline");
      assert.equal(error.serving.codeIdentity?.observed?.candidate, "e".repeat(40));
      assert.equal(error.serving.codeIdentity?.expected.candidate, "a".repeat(40));
      assert.equal(f.now - epoch, containerCodeAdoptionMs);
      assert.equal(f.startupAt, -1);
      const table = refusalTable(error);
      assert.match(table, new RegExp("e".repeat(40)));
      assert.match(table, new RegExp("a".repeat(40)));
      return true;
    }),
  );
});

test("never allocated refuses at the existing instance bound with the last state", async () => {
  const f = fixture("never-allocated");
  await atClock(f, async () =>
    assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof ServingFailure);
      assert.equal(error.serving.check, "instance-start");
      assert.equal(error.serving.cause, "instance-deadline");
      assert.deepEqual(error.serving.observation?.instances, []);
      assert.equal(f.now - epoch, 240_000);
      return true;
    }),
  );
});

test("never ready retains HTTP status, stage and last state in evidence and the job table", async () => {
  const f = fixture("never-ready");
  const directory = await mkdtemp(join(tmpdir(), "serving-failure-"));
  try {
    let failure: ServingFailure | undefined;
    await atClock(f, async () =>
      assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof ServingFailure);
        failure = error;
        return true;
      }),
    );
    assert.ok(failure);
    assert.equal(failure.serving.check, "deployment-readiness");
    assert.equal(failure.serving.status, 503);
    assert.equal(f.now, f.startupAt + 180_000);
    await releaseEvidence(directory, "a".repeat(40)).failure(failure);
    const value = JSON.parse(await readFile(join(directory, "failure.json"), "utf8"));
    assert.equal(value.serving.status, 503);
    assert.equal(value.serving.observation.instances[0].state, "running");
    assert.match(refusalTable(value), /deployment-readiness.*status=503/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
