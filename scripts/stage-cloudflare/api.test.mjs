import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudflareApi,
  isCloudflareApiError,
  ownedBy,
  ownedWorkers,
  workerListings,
} from "./api.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const api = (answer) =>
  cloudflareApi({ accountId: "acct", token: "t", fetcher: async (url, init) => answer(url, init) });

test("a call throws on any refusal, with codes and known fields but never the remote message", async () => {
  const refused = api(() =>
    json(
      {
        success: false,
        errors: [{ code: 10021, message: "max_instances too high for token abc123secret" }],
      },
      400,
    ),
  );
  await assert.rejects(refused.cf("containers/applications/a1", "PATCH", {}), (error) => {
    assert.equal(error.message, "Cloudflare PATCH containers/applications failed (400)");
    assert.deepEqual(error.diagnostic, {
      provider: "cloudflare",
      operation: "containers/applications",
      method: "PATCH",
      status: 400,
      codes: [10021],
      fields: ["max_instances"],
    });
    assert.ok(isCloudflareApiError(error));
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /secret/u);
    return true;
  });
  await assert.rejects(
    api(() => json({ success: false })).cf("workers/subdomain"),
    /failed \(200\)/u,
  );
  await assert.rejects(api(() => json({}, 404)).cf("workers/subdomain"), /failed \(404\)/u);
});

test("only a read by id answers absent, and a listing never does", async () => {
  assert.equal(await api(() => json({}, 404)).find("workers/scripts/x/settings"), null);
  await assert.rejects(
    api(() => json({}, 403)).find("workers/scripts/x/settings"),
    /failed \(403\)/u,
  );
  await assert.rejects(api(() => json({}, 404)).list("workers/scripts"), /Unrecognized/u);
  await assert.rejects(api(() => json({ result: null })).list("workers/scripts"), /Unrecognized/u);
});

test("a stage's resources are found only by its prefix", async () => {
  const owned = ownedBy("basalt-x");
  const rows = {
    "containers/applications": [{ name: "basalt-x-mock" }, { name: "basalt-xy" }],
    "workers/durable_objects/namespaces": [{ script: "basalt-x-gw" }, { script: "basalt-api" }],
    "workers/scripts": [{ id: "basalt-x-gw" }, { id: "basalt-x" }],
  };
  const list = async (path) => rows[path];
  assert.deepEqual(ownedWorkers(await Promise.all(workerListings(list)), owned), {
    applications: [{ name: "basalt-x-mock" }],
    namespaces: [{ script: "basalt-x-gw" }],
    scripts: [{ id: "basalt-x-gw" }],
  });
});

test("the scale test still reads a missing resource as null and throws on every other refusal", async (t) => {
  const answers = [json({}, 404), json({}, 500), json({ success: true, result: [] })];
  t.mock.method(globalThis, "fetch", async () => answers.shift());
  const scale = await import("../scale-test/api.mjs");
  assert.equal(await scale.cf("workers/scripts/x/settings"), null);
  await assert.rejects(
    scale.cf("workers/scripts/x", "DELETE"),
    /Cloudflare DELETE workers\/scripts failed \(500\)/u,
  );
  assert.deepEqual(await scale.list("workers/scripts"), []);
});
