import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeProofFixture } from "../../scripts/pool-fleet/test/runtime-proof-fixture.ts";
import { canonical, digest } from "../../scripts/pool-fleet/manifest.ts";
import { runtimeApplicationConfigDigest } from "../../scripts/pool-fleet/runtime-slot-manifest.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";
import { RuntimeProviderReader, ProviderObservationRefused } from "./runtime-provider/read.ts";
import {
  destroyedInstance as destroyed,
  runningInstance as running,
} from "../../scripts/pool-fleet/test/cloudflare-shapes.ts";

async function fixture(
  options: {
    wrongSibling?: boolean;
    absent?: boolean;
    rollout?: boolean;
    drift?: boolean;
    duplicate?: boolean;
    repeatCursor?: boolean;
    targetState?: string;
    siblingState?: string;
    siblingImage?: string;
    listing?: (target: string, image: string, application: string) => unknown[];
    // Every provider answer is this status, without a body.
    status?: number;
    // The application answer carries these envelope errors.
    errors?: readonly unknown[];
    // The application answer adds these fields, as a provider that grew a setting would.
    added?: Record<string, unknown>;
    // The second application read reports another creation, as after a recreate.
    recreated?: boolean;
    // Each provider answer takes this long on the reader's clock.
    readMs?: number;
  } = {},
) {
  const f = await runtimeProofFixture();
  f.raw.max_instances = 64;
  const expected = {
    ...f.manifest.provider,
    applicationId: f.raw.id,
    applicationVersion: "1",
    imageDigest: f.manifest.target.imageDigest,
    applicationConfigDigest: runtimeApplicationConfigDigest(decodeProviderApplication(f.raw)),
  };
  let applicationReads = 0,
    elapsed = 0;
  const paths: string[] = [];
  const reader = new RuntimeProviderReader(
    "synthetic-only-provider-token",
    async (input, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal);
      const url = new URL(input);
      assert.equal(url.origin, "https://api.cloudflare.com");
      paths.push(url.pathname);
      elapsed += options.readMs ?? 0;
      if (options.status) return new Response(null, { status: options.status });
      if (url.pathname.endsWith("instances-v2")) {
        const value = (id: string, image = f.raw.configuration.image, state = "running") => ({
          id,
          image,
          application_id: f.raw.id,
          status: { state },
        });
        const result = options.listing
          ? options.listing(f.manifest.target.instanceId, f.raw.configuration.image, f.raw.id)
          : [
              value(
                options.absent ? "other-instance" : f.manifest.target.instanceId,
                undefined,
                options.targetState,
              ),
              value(
                options.duplicate ? f.manifest.target.instanceId : "sibling",
                options.wrongSibling ? "wrong-image" : options.siblingImage,
                options.siblingState,
              ),
            ];
        return Response.json({
          success: true,
          errors: [],
          result,
          result_info: { next_page_token: options.repeatCursor ? "same-cursor" : "" },
        });
      }
      applicationReads++;
      return Response.json({
        success: true,
        errors: options.errors ?? [],
        result: {
          ...f.raw,
          version: options.drift && applicationReads > 1 ? 2 : 1,
          ...(options.recreated && applicationReads > 1
            ? { created_at: "2026-11-10T00:00:00Z" }
            : {}),
          ...(options.rollout ? { active_rollout_id: "rollout" } : {}),
          ...options.added,
        },
      });
    },
    () => f.now + elapsed,
  );
  return { ...f, reader, expected, paths };
}

test("runtime and release observation preserve exactly the same configuration and canonical digests", async () => {
  const f = await fixture();
  const decoded = decodeProviderApplication(f.raw);
  assert.equal(
    await providerDigest(runtimeApplicationSettings(decoded)),
    runtimeApplicationConfigDigest(decoded),
  );
  for (const value of [f.raw, decoded, { a: undefined, B: 1, a1: [null, "hello"] }])
    assert.equal(await providerDigest(value), digest(canonical(value)));
  const application = await f.reader.observe("launch", f.expected);
  const runtime = await f.reader.observe("attested", f.expected, f.manifest.target.instanceId);
  assert.equal("instanceId" in application, false);
  assert.equal(
    "instanceId" in runtime ? runtime.instanceId : undefined,
    f.manifest.target.instanceId,
  );
  assert.notEqual(application.observationDigest, runtime.observationDigest);
  assert.equal(f.paths.filter((path) => path.endsWith("instances-v2")).length, 1);
});

test("a named instance cannot borrow a sibling's proof or survive application drift", async () => {
  for (const options of [
    { wrongSibling: true },
    { absent: true },
    { rollout: true },
    { drift: true },
    { duplicate: true },
    { repeatCursor: true },
  ]) {
    const f = await fixture(options);
    await assert.rejects(
      f.reader.observe("attested", f.expected, f.manifest.target.instanceId),
      /^Error: Pool provider observation refused$/,
    );
  }
});

test("unavailable or oversized provider responses return only a closed error", async () => {
  const f = await fixture();
  const marker = "private-token-or-provider-body";
  for (const fetcher of [
    async () => {
      throw new Error(marker);
    },
    async () => new Response(marker, { status: 403 }),
    async () => new Response(marker.repeat(100_000)),
    async () => Response.json({ success: true, errors: [], result: { private: marker } }),
  ]) {
    const reader = new RuntimeProviderReader(marker, fetcher);
    await assert.rejects(reader.observe("launch", f.expected), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Pool provider observation refused");
      assert.equal(String(error).includes(marker), false);
      return true;
    });
  }
});

test("retirement releases no resource guard until the exact provider instance is absent", async () => {
  const present = await fixture();
  assert.equal(
    await present.reader.absent(present.expected, present.manifest.target.instanceId),
    false,
  );
  const absent = await fixture({ absent: true });
  assert.equal(
    await absent.reader.absent(absent.expected, absent.manifest.target.instanceId),
    true,
  );
  for (const options of [
    { wrongSibling: true },
    { rollout: true },
    { drift: true },
    { duplicate: true },
    { repeatCursor: true },
  ]) {
    const uncertain = await fixture(options);
    assert.equal(
      await uncertain.reader.absent(uncertain.expected, uncertain.manifest.target.instanceId),
      false,
    );
  }
});

test("the production listing, one destroyed instance beside none running, is absent once the driver reported it stopped", async () => {
  const f = await fixture({ listing: (target, image, app) => [destroyed(target, image, app)] });
  const stopped = { driverStopped: true } as const;
  assert.equal(
    await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
    true,
  );
  assert.equal(await f.reader.absent(f.expected, f.manifest.target.instanceId), false);
  assert.equal(await f.reader.empty(f.expected), false);
});

test("observe proves a running target beside a destroyed neighbour listed as production listed it", async () => {
  const f = await fixture({
    listing: (target, image, app) => [
      running(target, image, app),
      destroyed("neighbour", image, app),
    ],
  });
  const proof = await f.reader.observe("attested", f.expected, f.manifest.target.instanceId);
  assert.equal("instanceId" in proof ? proof.instanceId : undefined, f.manifest.target.instanceId);
  // A destroyed target is never observed, whatever runs beside it.
  const gone = await fixture({
    listing: (target, image, app) => [
      destroyed(target, image, app),
      running("neighbour", image, app),
    ],
  });
  await assert.rejects(
    gone.reader.observe("attested", gone.expected, gone.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
});

test("a target the provider lists as stopped or failed is present, each with its own reason", async (context) => {
  const lines = context.mock.method(console, "info", () => {});
  const stopped = { driverStopped: true } as const;
  for (const state of ["stopped", "failed"]) {
    const f = await fixture({ targetState: state, siblingState: "inactive" });
    assert.equal(
      await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
      false,
    );
  }
  assert.deepEqual(
    lines.mock.calls.map((call) => call.arguments),
    [
      ["POOL_PROVIDER_ABSENCE", { reason: "stopped" }],
      ["POOL_PROVIDER_ABSENCE", { reason: "failed" }],
    ],
  );
});

test("of the documented states only inactive counts as stopped; stopped, failed and unknown may still run", async () => {
  const stopped = { driverStopped: true } as const;
  for (const [state, absent] of [
    ["stopped", false],
    ["inactive", true],
    ["failed", false],
    ["unknown", false],
    ["stopping", false],
    ["unhealthy", false],
    ["provisioning", false],
    ["running", false],
  ] as const) {
    const f = await fixture({ absent: false, targetState: state, siblingState: "inactive" });
    assert.equal(
      await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
      absent,
      state,
    );
  }
});

test("an undocumented state is never absent or proof, and refuses with its own reason", async (context) => {
  const lines = context.mock.method(console, "info", () => {});
  const f = await fixture({ targetState: "hibernating" });
  const stopped = { driverStopped: true } as const;
  assert.equal(
    await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
    false,
  );
  await assert.rejects(
    f.reader.observe("attested", f.expected, f.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
  assert.deepEqual(
    lines.mock.calls.map((call) => call.arguments),
    [["POOL_PROVIDER_ABSENCE", { reason: "unknown_state" }]],
  );
});

// The provider keeps listing a destroyed instance under state=active and reports it "inactive"
// (seen on production, 22 Nov 2026: listed for over an hour after its destroy).
test("an instance listed only as inactive is absent once the driver reported it stopped, and not before", async (context) => {
  const lines = context.mock.method(console, "info", () => {});
  const f = await fixture({ targetState: "inactive" });
  const stopped = { driverStopped: true } as const;
  assert.equal(
    await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
    true,
  );
  assert.equal(await f.reader.absent(f.expected, f.manifest.target.instanceId), false);
  assert.deepEqual(
    lines.mock.calls.map((call) => call.arguments),
    [["POOL_PROVIDER_ABSENCE", { reason: "listed" }]],
  );
  // The driver's report never stands in for a running listing.
  const running = await fixture();
  assert.equal(
    await running.reader.absent(
      running.expected,
      running.manifest.target.instanceId,
      undefined,
      stopped,
    ),
    false,
  );
});

test("an inactive sibling, even on an older image, neither refuses observation nor absence", async () => {
  const present = await fixture({ siblingState: "inactive", siblingImage: "older-image" });
  const proof = await present.reader.observe(
    "attested",
    present.expected,
    present.manifest.target.instanceId,
  );
  assert.equal(
    "instanceId" in proof ? proof.instanceId : undefined,
    present.manifest.target.instanceId,
  );
  assert.equal(
    await present.reader.absent(present.expected, present.manifest.target.instanceId),
    false,
  );
  const gone = await fixture({
    absent: true,
    siblingState: "inactive",
    siblingImage: "older-image",
  });
  assert.equal(await gone.reader.absent(gone.expected, gone.manifest.target.instanceId), true);
});

test("an instance in any other state still counts as present, and only a running one is observed", async () => {
  const f = await fixture({ targetState: "provisioning" });
  assert.equal(await f.reader.absent(f.expected, f.manifest.target.instanceId), false);
  await assert.rejects(
    f.reader.observe("attested", f.expected, f.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
  const stopped = await fixture({ targetState: "inactive" });
  await assert.rejects(
    stopped.reader.observe("attested", stopped.expected, stopped.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
});

test("a sibling in any state but running or inactive still refuses absence, never a named observation", async () => {
  const f = await fixture({ absent: true, siblingState: "provisioning" });
  const stopped = { driverStopped: true } as const;
  assert.equal(
    await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
    false,
  );
  // A cell's activation and retirement, and the root's recovery and retirement, read alike.
  for (const read of ["attested", "retire", "recovery", "root_retire"] as const) {
    const present = await fixture({ siblingState: "provisioning" });
    const proof = await present.reader.observe(
      read,
      present.expected,
      present.manifest.target.instanceId,
    );
    assert.equal(
      "instanceId" in proof ? proof.instanceId : undefined,
      present.manifest.target.instanceId,
      read,
    );
  }
});

test("an application counts as empty only with no listed instance at all, a stopped one included", async () => {
  const f = await fixture({ absent: true, targetState: "inactive", siblingState: "inactive" });
  assert.equal(await f.reader.empty(f.expected), false);
});

test("a refused absence logs one closed reason and nothing that identifies the runtime", async (context) => {
  const lines = context.mock.method(console, "info", () => {});
  const listed = await fixture();
  assert.equal(
    await listed.reader.absent(listed.expected, listed.manifest.target.instanceId),
    false,
  );
  const drifted = await fixture({ absent: true, drift: true });
  assert.equal(
    await drifted.reader.absent(drifted.expected, drifted.manifest.target.instanceId),
    false,
  );
  const calls = lines.mock.calls.filter((call) => call.arguments[0] === "POOL_PROVIDER_ABSENCE");
  assert.deepEqual(
    calls.map((call) => call.arguments[1]),
    [{ reason: "listed" }, { reason: "proof" }],
  );
  assert.equal(JSON.stringify(calls).includes(listed.manifest.target.instanceId), false);
});

test("missing and unreadable secrets report unknown without a provider call or absence proof", async () => {
  const f = await fixture();
  for (const credential of [
    undefined,
    { get: async () => null },
    {
      get: async (): Promise<string> => {
        throw new Error("synthetic-secret-error");
      },
    },
  ]) {
    let requests = 0;
    const reader = new RuntimeProviderReader(credential, async () => {
      requests++;
      throw new Error("Missing secret cannot reach the provider");
    });
    await assert.rejects(reader.observe("launch", f.expected), (error: unknown) => {
      assert.ok(error instanceof Error && "status" in error);
      assert.equal(error.status, "unknown");
      assert.equal(error.message, "Pool provider observation refused");
      return true;
    });
    assert.equal(await reader.absent(f.expected, f.manifest.target.instanceId), false);
    assert.equal(requests, 0);
  }
});

test("a stalled secret read respects the observation abort and never calls the provider", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = Promise.withResolvers<string | null>();
  let reads = 0;
  const reader = new RuntimeProviderReader({ get: () => pending.promise }, async () => {
    reads++;
    throw new Error("An aborted secret read cannot call the provider");
  });
  const observation = reader.observe("launch", f.expected, undefined, controller.signal);
  controller.abort();
  await assert.rejects(observation, /provider observation refused/);
  pending.resolve("synthetic-provider-token");
  assert.equal(reads, 0);
});

test("synchronous and asynchronous fetch exceptions retain a closed cause without a raw error", async () => {
  const f = await fixture();
  const marker = "private-provider-or-credential";
  for (const fetcher of [
    (): Promise<Response> => {
      throw new Error(marker);
    },
    async (): Promise<Response> => {
      throw new Error(marker);
    },
  ]) {
    await assert.rejects(
      new RuntimeProviderReader(marker, fetcher).observe("launch", f.expected),
      (error: unknown) => {
        assert.ok(error instanceof ProviderObservationRefused);
        assert.equal(error.code, "provider_fetch_failed");
        assert.equal(error.status, "unknown");
        assert.equal(error.message, "Pool provider observation refused");
        assert.equal("cause" in error, false);
        assert.equal(JSON.stringify(error).includes(marker), false);
        return true;
      },
    );
  }
});

/** The closed refusal an observation rejected with: its code, its read and why, nothing else. */
async function refusal(observation: Promise<unknown>) {
  try {
    await observation;
  } catch (error) {
    assert.ok(error instanceof ProviderObservationRefused);
    return { code: error.code, read: error.read, ...error.refusal };
  }
  return assert.fail("the observation was not refused");
}
const refused = (read: string, why: object) => ({
  code: "provider_observation_refused",
  read,
  ...why,
});

test("an application read that disagrees with a pin names the pin, and a bad target says so", async () => {
  const f = await fixture();
  for (const [expected, why] of [
    [{ ...f.expected, accountId: "not-an-account" }, { reason: "target_invalid" }],
    [
      { ...f.expected, accountId: "2".repeat(32) },
      { reason: "mismatch", field: "account" },
    ],
    [
      { ...f.expected, applicationId: "other-application" },
      { reason: "mismatch", field: "application" },
    ],
    [
      { ...f.expected, applicationVersion: "2" },
      { reason: "mismatch", field: "version" },
    ],
    [
      { ...f.expected, namespaceId: "other-namespace" },
      { reason: "mismatch", field: "namespace" },
    ],
    [
      { ...f.expected, imageDigest: `sha256:${"b".repeat(64)}` },
      { reason: "mismatch", field: "image" },
    ],
    [
      { ...f.expected, applicationConfigDigest: "c".repeat(64) },
      { reason: "mismatch", field: "settings" },
    ],
  ] as const)
    assert.deepEqual(
      await refusal(f.reader.observe("configure", expected)),
      refused("configure", why),
      JSON.stringify(why),
    );
});

test("each refused provider answer carries one closed reason, a 429 and a 503 their status", async () => {
  for (const [options, why] of [
    [{ status: 429 }, { reason: "read_status", status: 429 }],
    [{ status: 503 }, { reason: "read_status", status: 503 }],
    [{ status: 401 }, { reason: "credential_refused" }],
    [{ status: 403 }, { reason: "credential_refused" }],
    [{ errors: [{ code: 10000, message: "Authentication error" }] }, { reason: "envelope_error" }],
    [{ added: { autoscaling: { enabled: false } } }, { reason: "decode_failed" }],
    [{ rollout: true }, { reason: "rollout_active" }],
    [{ readMs: 31_000 }, { reason: "slow" }],
  ] as const) {
    const f = await fixture(options);
    assert.deepEqual(
      await refusal(f.reader.observe("launch", f.expected)),
      refused("launch", why),
      JSON.stringify(options),
    );
  }
});

test("a body over the limit, a body that isn't JSON and a failed fetch each say which", async () => {
  const f = await fixture();
  for (const [fetcher, code, reason] of [
    [
      async () => new Response("x".repeat(2_000_001)),
      "provider_observation_refused",
      "body_too_large",
    ],
    [async () => new Response("<html>"), "provider_observation_refused", "decode_failed"],
    [
      async (): Promise<Response> => {
        throw new Error("synthetic socket reset");
      },
      "provider_fetch_failed",
      "fetch_failed",
    ],
  ] as const)
    assert.deepEqual(
      await refusal(
        new RuntimeProviderReader("synthetic-token", fetcher).observe("launch", f.expected),
      ),
      { code, read: "launch", reason },
    );
});

test("a token read that fails is unavailable, one the deadline cut is slow, and an empty one is refused", async () => {
  const f = await fixture();
  const unreachable = async (): Promise<Response> => assert.fail("no token, no provider call");
  const failing = {
    get: async (): Promise<string> => {
      throw new Error("synthetic secret store failure");
    },
  };
  const stalled = { get: () => new Promise<string>(() => {}) };
  for (const [credential, signal, reason] of [
    [failing, undefined, "credential_unavailable"],
    [stalled, AbortSignal.abort(), "slow"],
    [{ get: async () => null }, undefined, "credential_refused"],
    [{ get: async () => "" }, undefined, "credential_refused"],
  ] as const)
    assert.deepEqual(
      await refusal(
        new RuntimeProviderReader(credential, unreachable).observe(
          "recovery",
          f.expected,
          undefined,
          signal,
        ),
      ),
      { code: "provider_observation_refused", read: "recovery", reason },
    );
  // The observation's deadline fires while the token read is still pending.
  const deadline = new AbortController();
  const observation = new RuntimeProviderReader(stalled, unreachable).observe(
    "recovery",
    f.expected,
    undefined,
    deadline.signal,
  );
  deadline.abort();
  assert.deepEqual(await refusal(observation), {
    code: "provider_observation_refused",
    read: "recovery",
    reason: "slow",
  });
  // A fetch that throws stays a failed fetch, even when the deadline is what cut it.
  const cut = new AbortController();
  const aborted = async (): Promise<Response> => {
    cut.abort();
    throw new DOMException("The operation was aborted", "AbortError");
  };
  assert.deepEqual(
    await refusal(
      new RuntimeProviderReader("synthetic-token", aborted).observe(
        "recovery",
        f.expected,
        undefined,
        cut.signal,
      ),
    ),
    { code: "provider_fetch_failed", read: "recovery", reason: "fetch_failed" },
  );
});

// The recorded running shape with another documented state: no stopping or starting instance was
// recorded, and the reader reads only id, application, image and state.
const inState = (shape: ReturnType<typeof running>, state: string) => ({
  ...shape,
  status: { ...shape.status, state },
});

test("an attested start beside a sibling still stopping or starting proves the named instance, and absence still waits", async (context) => {
  const lines = context.mock.method(console, "info", () => {});
  for (const state of [
    "stopping",
    "provisioning",
    "failed",
    "unhealthy",
    "unknown",
    "hibernating",
  ]) {
    const f = await fixture({
      listing: (target, image, app) => [
        running(target, image, app),
        inState(running("sibling", image, app), state),
      ],
    });
    const proof = await f.reader.observe("attested", f.expected, f.manifest.target.instanceId);
    assert.equal(
      "instanceId" in proof ? proof.instanceId : undefined,
      f.manifest.target.instanceId,
      state,
    );
    // The same listing still proves no absence of a gone target: a sibling may yet start or stop.
    const gone = await fixture({
      listing: (_target, image, app) => [inState(running("sibling", image, app), state)],
    });
    assert.equal(
      await gone.reader.absent(gone.expected, gone.manifest.target.instanceId),
      false,
      state,
    );
  }
  assert.deepEqual(
    lines.mock.calls.map((call) => call.arguments),
    [
      ...Array.from({ length: 5 }, () => ["POOL_PROVIDER_ABSENCE", { reason: "instances" }]),
      ["POOL_PROVIDER_ABSENCE", { reason: "unknown_state" }],
    ],
  );
});

// What the attested proof still judges, each beside a sibling that is stopping: the named instance.
test("beside a stopping sibling, the proof still refuses a named instance not running, on another image, or an application that changed", async () => {
  const stopping = (image: string, app: string) =>
    inState(running("sibling", image, app), "stopping");
  const cases = [
    // Not running: still starting, stopping, destroyed, in an undocumented state, or not listed.
    ...["provisioning", "stopping", "inactive", "hibernating"].map(
      (state) =>
        [
          (target: string, image: string, app: string) => [
            inState(running(target, image, app), state),
            stopping(image, app),
          ],
          {},
          { reason: "instance_not_running" },
        ] as const,
    ),
    [
      (_target: string, image: string, app: string) => [
        running("other", image, app),
        stopping(image, app),
      ],
      {},
      { reason: "instance_not_running" },
    ],
    // Running, but not the admitted image.
    [
      (target: string, image: string, app: string) => [
        running(target, image.replace(/@sha256:.*/u, `@sha256:${"f".repeat(64)}`), app),
        stopping(image, app),
      ],
      {},
      { reason: "mismatch", field: "image" },
    ],
    // Running the admitted image, while the application was recreated between the two reads.
    [
      (target: string, image: string, app: string) => [
        running(target, image, app),
        stopping(image, app),
      ],
      { recreated: true },
      { reason: "changed_between_reads" },
    ],
  ] as const;
  for (const [index, [listing, options, why]] of cases.entries()) {
    const f = await fixture({ listing, ...options });
    assert.deepEqual(
      await refusal(f.reader.observe("attested", f.expected, f.manifest.target.instanceId)),
      refused("attested", why),
      `case ${index}`,
    );
  }
});

test("each attested refusal of the instance listing carries its own closed reason", async () => {
  for (const [options, why] of [
    [{ targetState: "provisioning" }, { reason: "instance_not_running" }],
    [{ targetState: "hibernating" }, { reason: "instance_not_running" }],
    [{ absent: true }, { reason: "instance_not_running" }],
    [{ wrongSibling: true }, { reason: "mismatch", field: "image" }],
    [{ duplicate: true }, { reason: "decode_failed" }],
    [{ repeatCursor: true }, { reason: "decode_failed" }],
    [{ recreated: true }, { reason: "changed_between_reads" }],
    [{ drift: true }, { reason: "mismatch", field: "version" }],
    [{ readMs: 11_000 }, { reason: "slow" }],
  ] as const) {
    const f = await fixture(options);
    assert.deepEqual(
      await refusal(f.reader.observe("retire", f.expected, f.manifest.target.instanceId)),
      refused("retire", why),
      JSON.stringify(options),
    );
  }
});
