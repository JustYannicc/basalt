import assert from "node:assert/strict";
import test from "node:test";
import { assertPoolImage, poolImageReceipt, waitForPoolImage } from "./pool-image.ts";

const candidate = "a".repeat(40);
const digest = `sha256:${"2".repeat(64)}`;
const image = `registry.cloudflare.com/fixture/pool@${digest}`;
const receipt = { candidate, applicationId: "pool-app", accountId: "fixture", workerName: "pool-worker", inputHash: "b".repeat(16), digest, platform: "linux/amd64", capability: "oauth-completion-receipts-v1" };
const credentials = { accountId: "fixture", apiToken: "synthetic-never-sent" };
const instance = (id: string) => ({ id, application_id: "pool-app", image, status: { state: "running" } });
const envelope = (result: unknown, result_info: unknown = {}) => Response.json({ success: true, errors: [], messages: [], result, result_info });
const settings = () => envelope({ bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: receipt.inputHash }] });

test("the publication receipt keeps input hashes separate from immutable digests and binds the candidate", () => {
  assert.equal(poolImageReceipt(receipt, candidate).digest, digest);
  assert.throws(() => poolImageReceipt(receipt, "c".repeat(40)), /candidate/);
  assert.throws(() => poolImageReceipt({ ...receipt, digest: receipt.inputHash }, candidate), /digest is invalid/);
  assert.throws(() => poolImageReceipt({ ...receipt, platform: "linux/arm64" }, candidate), /candidate/);
});

test("image verification checks every active instance across cursor pages", async () => {
  const calls: string[] = [];
  const result = await assertPoolImage(receipt, candidate, credentials, async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("settings")) return settings();
    if (!url.pathname.endsWith("instances-v2")) return envelope({ id: "pool-app", account_id: "fixture", configuration: { image } });
    assert.equal(url.searchParams.get("state"), "active");
    return url.searchParams.has("page_token") ? envelope([instance("two")]) : envelope([instance("one")], { next_page_token: "next" });
  });
  assert.deepEqual(result.instances, ["one", "two"]);
  assert.equal(calls.length, 4);
});

test("image verification refuses application drift, one stale instance, no instance and unready instances", async () => {
  const stale = `registry.cloudflare.com/fixture/pool@sha256:${"4".repeat(64)}`;
  for (const scenario of [
    { application: stale, instances: [instance("one")], reason: /application image differs/ },
    { application: image, instances: [instance("one"), { ...instance("two"), image: stale }], reason: /instance image differs/ },
    { application: image, instances: [], reason: /no running instance/ },
    { application: image, instances: [{ ...instance("one"), status: { state: "provisioning" } }], reason: /not running/ },
  ]) {
    await assert.rejects(assertPoolImage(receipt, candidate, credentials, async (input) => String(input).endsWith("settings") ? settings() : String(input).includes("instances-v2")
      ? envelope(scenario.instances)
      : envelope({ id: "pool-app", account_id: "fixture", configuration: { image: scenario.application } })), scenario.reason);
  }
});

test("uncertain pagination cannot silently omit an active instance", async () => {
  await assert.rejects(assertPoolImage(receipt, candidate, credentials, async (input) => String(input).endsWith("settings") ? settings() : String(input).includes("instances-v2")
    ? envelope([instance("one")], { next_page_token: "repeated" })
    : envelope({ id: "pool-app", account_id: "fixture", configuration: { image } })), /duplicate|pagination/);
});

test("rollout observation waits within the existing readiness budget and never retries a deployment", async () => {
  let now = 0;
  let warmCalls = 0;
  const result = await waitForPoolImage(receipt, candidate, credentials, "https://fixture.invalid", async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = String(input);
    if (url.endsWith("/pool/v1/pool")) { warmCalls++; return new Response(null, { status: 401 }); }
    if (url.endsWith("settings")) return settings();
    if (url.includes("instances-v2")) return envelope([instance("one")]);
    return envelope({ id: "pool-app", account_id: "fixture", configuration: { image: now === 0 ? "old-image" : image } });
  }, { timeoutMs: 10, intervalMs: 1, now: () => now, sleep: async (ms) => { now += ms; } });
  assert.equal(warmCalls, 2);
  assert.equal(result.digest, digest);
});
