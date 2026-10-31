import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountMirrorPath, accountMirrorPrefix, handleAccountKeyMirror } from "../../src/pool/account-key-mirror.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture } from "./sharing-fixture.ts";
import { TypeSafeFixture } from "./typesafe-fixture.ts";
import { TypeSafeClient, noul, image } from "./sdk/client.ts";

test("native TypeSafe SDK retains protocol, Home authority, errors, usage and account lifecycle", { timeout: 240_000 }, async () => {
  const candidate = process.env.POOL_TEST_IMAGE;
  assert.ok(candidate, "Build the candidate pool image");
  const upstream = new TypeSafeFixture();
  let fixture: SharingFixture | undefined;
  try {
    await upstream.provider.start();
    fixture = new SharingFixture({ image: candidate, resourcePrefix: "basalt-typesafe", poolContainerArgs: upstream.provider.poolContainerArgs });
    fixture.addLogRedactions(["synthetic-typesafe-a", "synthetic-typesafe-b"]);
    await fixture.start();
    // Native plugin callbacks use the host-wide transport policy for model discovery.
    await fixture.data("/config", "PATCH", { requests: { "proxy-url": upstream.provider.url } });
    const client = new HomeClient((path, init) => fixture!.fetchHome(path, init));
    const first = new PoolHome(client, "fixture-typesafe-a"), second = new PoolHome(client, "fixture-typesafe-b");
    const ids: string[] = [];
    for (const token of ["synthetic-typesafe-a", "synthetic-typesafe-b"]) {
      const reference = randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        const at = Date.now();
        const envelope = await signEnvelope("ab".repeat(32), accountMirrorPrefix, {
          action: "upsert", reference, at, expiresAt: at + 30_000,
          credential: { type: "typesafe", token, proxy_url: upstream.provider.url },
        });
        const saved = await handleAccountKeyMirror(new Request(`https://pool.example${accountMirrorPath}`, {
          method: "POST", body: JSON.stringify({ envelope }),
        }), { home: client, signingKey: "ab".repeat(32) });
        assert.equal(saved.status, 200);
      }
      ids.push(reference);
    }
    const credentials = await fixture.data<{ files: { id: string }[] }>("/credentials");
    assert.equal(credentials.files.filter(row => ids.includes(row.id)).length, 2);
    await first.add([ids[0]!]);
    await second.add([ids[1]!]);
    const keyA = await new ComputerHome(client).mint("typesafe-owner", "fixture-typesafe-a", "typesafe-computer-a");
    const keyB = await new ComputerHome(client).mint("typesafe-owner", "fixture-typesafe-b", "typesafe-computer-b");
    const sdk = new TypeSafeClient({ baseURL: `${fixture.node}/typesafe`, apiKey: keyA.key, defaultModel: "jev-latest", retry: { maxRetries: 0 } });
    const deadline = Date.now() + 30_000;
    let models: Awaited<ReturnType<typeof sdk.models.list>> = [];
    do {
      models = await sdk.models.list();
      if (models.some((model) => model.name === "jev-latest")) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.deepEqual(models.map((model) => model.name).sort(), ["jev-latest", "jev-preview"], JSON.stringify({
      providerRequests: upstream.provider.requests,
      catalog: await (await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${keyA.key}` } })).json(),
      membership: await first.membership(),
      plugins: await fixture.data("/plugins"),
    }));
    assert.equal(models[0]!.description, "Latest stable Jev System One model");
    assert.equal(models[0]!.release_date, "2026-10-14");
    const result = await sdk.systemOne({ state: "private-typesafe-state-173".repeat(80), questions: { decision: noul("Does this need attention?"), second: noul("Can it wait?") } });
    assert.equal(result.answers.decision.noul, 0.75);
    assert.equal(result.answers.second.noul, 0.75);
    assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 3 });
    assert.equal(upstream.calls.at(-1)!.encoding, "zstd");
    assert.equal(upstream.calls.at(-1)!.key, "Bearer synthetic-typesafe-a");
    const body = { model: "jev-latest", state: "private-typesafe-state-173", questions: { decision: { type: "noul", instructions: "Is this urgent?" } } };
    async function post(path: string, bytes: BodyInit, headers: Record<string, string> = {}, key = keyA.key) {
      return fetch(`${fixture!.node}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers }, body: bytes });
    }
    const gzip = await post("/v1/systemone", gzipSync(JSON.stringify(body)), { "Content-Encoding": "gzip" });
    assert.equal(gzip.status, 200);
    assert.deepEqual(await gzip.json(), { model: "jev-latest", answers: { decision: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 17, output_tokens: 3 } });
    assert.equal(upstream.calls.at(-1)!.encoding, "gzip");
    await sdk.systemOne({ state: { picture: image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64")) }, questions: { visible: noul("Is it visible?") } }, { headers: { "TypeSafe-Danger-Zone-Images": "true" } });
    assert.equal(upstream.calls.at(-1)!.multipart, true);
    assert.equal(upstream.calls.at(-1)!.images, 1);
    assert.equal(upstream.calls.at(-1)!.danger, "true");
    const catalog = await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${keyA.key}` } });
    const shared = await catalog.json() as { data: { id: string; protocols?: string[]; endpoints?: string[] }[] };
    assert.deepEqual(shared.data.find((model) => model.id === "jev-latest")?.protocols, ["typesafe-systemone"]);
    assert.deepEqual(shared.data.find((model) => model.id === "jev-latest")?.endpoints, ["/v1/systemone"]);
    assert.equal(shared.data.some((model) => model.id === "jev-b"), false);
    const picker = await fetch(`${fixture.node}/v1/models?client_version=1.0.0`, { headers: { Authorization: `Bearer ${keyA.key}` } });
    assert.doesNotMatch(await picker.text(), /jev-latest|jev-preview/);
    const count = upstream.calls.length;
    assert.equal((await post("/v1/systemone", JSON.stringify(body), {}, keyB.key)).status, 200);
    assert.equal(upstream.calls.at(-1)!.key, "Bearer synthetic-typesafe-b");
    const afterSecondPool = upstream.calls.length;
    assert.equal((await post("/v1/systemone", JSON.stringify(body), {}, "invalid-pool-key")).ok, false);
    assert.equal(upstream.calls.length, afterSecondPool);
    assert.equal((await post("/v1/chat/completions", JSON.stringify({ model: "jev-latest", messages: [] }))).status, 415);
    assert.equal(upstream.calls.length, afterSecondPool);
    for (const status of [400, 401, 413, 415, 422, 429, 529]) {
      upstream.failure = status;
      const response = await post("/typesafe/v1/systemone", JSON.stringify(body));
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Retry-After"), "7");
      assert.deepEqual(await response.json(), { detail: `native-typesafe-${status}` });
    }
    upstream.failure = 0;
    upstream.disconnect = true;
    const before = upstream.calls.length;
    assert.equal((await post("/v1/systemone", JSON.stringify(body))).status, 502);
    assert.equal(upstream.calls.length, before + 1, "An uncertain send must not retry another account");
    upstream.disconnect = false;
    await fixture.replaceImage(candidate);
    const resumedSdk = new TypeSafeClient({ baseURL: `${fixture.node}/typesafe`, apiKey: keyA.key, defaultModel: "jev-latest", retry: { maxRetries: 0 } });
    assert.equal((await resumedSdk.systemOne({ state: "resumed", questions: { decision: noul("Can it continue?") } })).answers.decision.noul, 0.75);
    assert.deepEqual(await fixture.diagnostics.scan(["synthetic-typesafe-a", "synthetic-typesafe-b", "private-typesafe-state-173"]), { database: 0, files: 0, logs: 0 });
  } finally {
    try { await fixture?.close(); } finally { await upstream.provider.close(); }
  }
});
