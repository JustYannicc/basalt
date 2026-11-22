import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeProofFixture } from "../../scripts/pool-fleet/test/runtime-proof-fixture.ts";
import { canonical, digest } from "../../scripts/pool-fleet/manifest.ts";
import { runtimeApplicationConfigDigest } from "../../scripts/pool-fleet/runtime-slot-manifest.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";
import { RuntimeProviderReader, ProviderObservationRefused } from "./runtime-provider/read.ts";

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
  let applicationReads = 0;
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
      if (url.pathname.endsWith("instances-v2")) {
        const value = (id: string, image = f.raw.configuration.image, state = "running") => ({
          id,
          image,
          application_id: f.raw.id,
          status: { state },
        });
        const result = [
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
        errors: [],
        result: {
          ...f.raw,
          version: options.drift && applicationReads > 1 ? 2 : 1,
          ...(options.rollout ? { active_rollout_id: "rollout" } : {}),
        },
      });
    },
    () => f.now,
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
  const application = await f.reader.observe(f.expected);
  const runtime = await f.reader.observe(f.expected, f.manifest.target.instanceId);
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
      f.reader.observe(f.expected, f.manifest.target.instanceId),
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
    await assert.rejects(reader.observe(f.expected), (error: unknown) => {
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
  const proof = await present.reader.observe(present.expected, present.manifest.target.instanceId);
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
    f.reader.observe(f.expected, f.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
  const stopped = await fixture({ targetState: "inactive" });
  await assert.rejects(
    stopped.reader.observe(stopped.expected, stopped.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
});

test("a sibling in any state but running or inactive still refuses observation and absence, as before", async () => {
  const f = await fixture({ absent: true, siblingState: "provisioning" });
  const stopped = { driverStopped: true } as const;
  assert.equal(
    await f.reader.absent(f.expected, f.manifest.target.instanceId, undefined, stopped),
    false,
  );
  const present = await fixture({ siblingState: "provisioning" });
  await assert.rejects(
    present.reader.observe(present.expected, present.manifest.target.instanceId),
    /^Error: Pool provider observation refused$/,
  );
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
    await assert.rejects(reader.observe(f.expected), (error: unknown) => {
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
  const observation = reader.observe(f.expected, undefined, controller.signal);
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
      new RuntimeProviderReader(marker, fetcher).observe(f.expected),
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
