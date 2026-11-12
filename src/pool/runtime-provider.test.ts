import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";
import { canonical, digest } from "../../scripts/release-barrier/manifest.ts";
import { runtimeApplicationConfigDigest } from "../../scripts/release-barrier/runtime-slot-provider-proof.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";

async function fixture(
  options: {
    wrongSibling?: boolean;
    absent?: boolean;
    rollout?: boolean;
    drift?: boolean;
    duplicate?: boolean;
    repeatCursor?: boolean;
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
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      const url = new URL(input);
      assert.equal(url.origin, "https://api.cloudflare.com");
      paths.push(url.pathname);
      if (url.pathname.endsWith("instances-v2")) {
        const value = (id: string, image = f.raw.configuration.image) => ({
          id,
          image,
          application_id: f.raw.id,
          status: { state: "running" },
        });
        const result = [
          value(options.absent ? "other-instance" : f.manifest.target.instanceId),
          value(
            options.duplicate ? f.manifest.target.instanceId : "sibling",
            options.wrongSibling ? "wrong-image" : undefined,
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
