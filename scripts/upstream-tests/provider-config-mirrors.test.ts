import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Option, Redacted, Result, Schema } from "effect";
import { providerDeclaration } from "../../.upstream/packages/apps/src/host.ts";
import { AccountId, OwnerId, identifyProvider } from "../../.upstream/packages/sdk/src/core.ts";
import { poolAccountAcquisition } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-acquisition.ts";
import { HostOperationFailed } from "../../.upstream/packages/apps/src/contracts/host.ts";
import { classifyAccountCheck } from "../../.upstream/packages/apps/src/implementation/account-check-errors.ts";
import {
  customEndpointRefusals,
  providers,
  type ProviderLab,
} from "../../src/pool/provider-accounts/definitions.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { handleAccountKeyMirror } from "../../src/pool/account-key-mirror.ts";
import { object, type Json } from "../../src/pool/json.ts";

const signingKey = "ab".repeat(32);
const reference = "12345678-abcd-4000-8000-000000000001";
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
async function fixture(
  lab: ProviderLab,
  method = "apiKey",
  fields: Readonly<Record<string, string>> = { token: "synthetic-saved-token" },
  discovery: (url: string) => Response = () => {
    throw new Error("Unexpected provider request");
  },
) {
  const options = await Effect.runPromise(
    poolAccountAcquisition(Option.some(Redacted.make(signingKey)), "https://pool.example").pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    ),
  );
  const identity = await Effect.runPromise(
    providerDeclaration(providers[lab]).pipe(
      Effect.flatMap((definition) => identifyProvider(definition, crypto)),
    ),
  );
  const registration = options.registrations.find(
    (item) => item.provider === identity.identity && item.method === method,
  );
  assert.ok(registration?.driver.mirror);
  const configs = new Map<string, unknown>();
  const files = new Map<string, Json>();
  const calls: string[] = [];
  const home = new HomeClient(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const value: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (path.includes("/config/")) {
      if (init?.method === "PUT") {
        configs.set(path, value);
        return Response.json({ status: "ok" });
      }
      return configs.has(path)
        ? Response.json(configs.get(path))
        : new Response(null, { status: 404 });
    }
    if (init?.method === "DELETE") {
      files.delete(reference);
      return new Response(null, { status: 204 });
    }
    assert.ok(object(value));
    assert.equal(value.uuid, reference);
    files.set(reference, value);
    return Response.json({ name: `${reference}.json` });
  });
  const requestFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://pool.example/"))
      return handleAccountKeyMirror(new Request(input, init), { home, signingKey });
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fields.token}`);
    return discovery(url);
  };
  const owner = OwnerId.make("organization:synthetic");
  const context = {
    owner,
    provider: identity.identity,
    method,
    operation: "fixture",
    deadline: Date.now() + 30_000,
    signal: new AbortController().signal,
    fetch: requestFetch,
    reference: Redacted.make(reference),
    fields: Redacted.make(fields),
    binding: {
      account: AccountId.make("acc_saved"),
      owner,
      provider: identity.identity,
      method,
      driver: "basalt-home",
      driverRevision: "provider-mirror-v1",
      generation: 1,
      revision: "saved-r1",
      removal: null,
    },
  };
  return {
    driver: registration.driver,
    configs,
    files,
    calls,
    context,
    mirror: () => Effect.runPromise(registration.driver.mirror!(context)),
    remove: () => Effect.runPromise(registration.driver.remove(context)),
  };
}

test("every native API-key family uses its assigned Home config key and supports removal", async () => {
  for (const [lab, family] of [
    ["openai", "codex"],
    ["anthropic", "claude"],
    ["gemini", "gemini"],
    ["vertex", "vertex"],
    ["xai", "xai"],
    ["meta", "meta"],
  ] as const) {
    const f = await fixture(lab);
    assert.equal(f.driver.observeAccount, undefined);
    await f.mirror();
    await f.mirror();
    const groups = f.configs.get(`/v8/management/config/api-keys/${family}`);
    assert.ok(Array.isArray(groups));
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].keys, [{ id: reference, "api-key": "synthetic-saved-token" }]);
    if (lab === "openai") assert.equal(groups[0]["base-url"], "https://api.openai.com/v1");
    await f.remove();
    assert.deepEqual(f.configs.get(`/v8/management/config/api-keys/${family}`), []);
    assert.equal(f.context.binding.account, "acc_saved");
  }
});

test("Moonshot and OpenRouter discover models and retain native compatibility routing", async () => {
  for (const lab of ["kimi", "openrouter"] as const) {
    const endpoint = lab === "kimi" ? "https://api.moonshot.ai/v1" : "https://openrouter.ai/api/v1";
    const f = await fixture(lab, "apiKey", { token: "synthetic-saved-token" }, (url) => {
      assert.equal(url, `${endpoint}/models`);
      return Response.json({ data: [{ id: "synthetic-model" }, { id: "synthetic-model" }] });
    });
    await f.mirror();
    assert.deepEqual(f.configs.get("/v8/management/config/api-keys/openai-compatibility"), [
      {
        name: `basalt-${lab}-${reference}`,
        "base-url": endpoint,
        models: [{ name: "synthetic-model", alias: "synthetic-model" }],
        keys: [{ id: reference, "api-key": "synthetic-saved-token" }],
      },
    ]);
    await f.remove();
    assert.deepEqual(f.configs.get("/v8/management/config/api-keys/openai-compatibility"), []);
  }
});

test("Workers AI uses the sole visible account or the existing explicit account ID without inference", async () => {
  const id = "a".repeat(32);
  for (const method of ["apiToken", "accountToken"]) {
    const discovery: string[] = [];
    const f = await fixture(
      "cloudflare",
      method,
      { token: "synthetic-saved-token", accountId: id },
      (url) => {
        discovery.push(url);
        if (url.includes("/accounts?"))
          return Response.json({
            success: true,
            result: [{ id }],
            result_info: { total_count: 1 },
          });
        assert.equal(
          url,
          `https://api.cloudflare.com/client/v4/accounts/${id}/ai/models/search?per_page=100&page=1`,
        );
        return Response.json({
          success: true,
          result: [
            { name: "@cf/synthetic-chat", task: { name: "Text Generation" } },
            { name: "@cf/synthetic-image", task: { name: "Text to Image" } },
          ],
        });
      },
    );
    await f.mirror();
    const groups = f.configs.get("/v8/management/config/api-keys/openai-compatibility");
    assert.ok(Array.isArray(groups));
    assert.equal(
      groups[0]["base-url"],
      `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1`,
    );
    assert.deepEqual(groups[0].models, [
      { name: "@cf/synthetic-chat", alias: "@cf/synthetic-chat" },
    ]);
    assert.equal(discovery.length, method === "apiToken" ? 2 : 1);
    await f.remove();
  }
});

test("multiple Cloudflare accounts and failed model discovery write no credentials", async () => {
  const multiple = await fixture("cloudflare", "apiToken", { token: "synthetic-saved-token" }, () =>
    Response.json({ success: true, result: [{ id: "a".repeat(32) }, { id: "b".repeat(32) }] }),
  );
  await assert.rejects(multiple.mirror(), /account API token/);
  assert.equal(multiple.calls.length, 0);
  const failed = await fixture(
    "kimi",
    "apiKey",
    { token: "synthetic-saved-token" },
    () => new Response("secret upstream error", { status: 403 }),
  );
  await assert.rejects(failed.mirror(), /configuration unavailable/);
  assert.equal(failed.calls.length, 0);
});

test("provider discovery refuses redirects before writing credentials", async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = await fixture(
      "kimi",
      "apiKey",
      { token: "synthetic-saved-token" },
      () =>
        new Response(null, {
          status,
          headers: { location: "https://synthetic-provider.invalid/models" },
        }),
    );
    await assert.rejects(f.mirror(), /configuration unavailable/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.configs.size, 0);
    assert.equal(f.files.size, 0);
  }
});

test("Vertex service-account mirror uses the documented payload and keeps its assigned UUID", async () => {
  const account = {
    type: "service_account",
    project_id: "synthetic-project",
    client_email: "synthetic@example.test",
    private_key: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const f = await fixture("vertex", "serviceAccount", {
    token: "unused",
    serviceAccount: JSON.stringify(account),
  });
  await f.mirror();
  await f.mirror();
  assert.deepEqual(f.files.get(reference), {
    type: "vertex",
    uuid: reference,
    service_account: account,
    project_id: account.project_id,
    email: account.client_email,
    location: "us-central1",
  });
  await f.remove();
  assert.equal(f.files.size, 0);
});

test("a full compatible catalog larger than the old mirror limit is retained without truncation", async () => {
  const ids = Array.from(
    { length: 800 },
    (_, index) => `synthetic-vendor/${"model".repeat(10)}-${index}`,
  );
  const f = await fixture("openrouter", "apiKey", { token: "synthetic-saved-token" }, () =>
    Response.json({ data: ids.map((id) => ({ id })) }),
  );
  await f.mirror();
  const groups = f.configs.get("/v8/management/config/api-keys/openai-compatibility");
  assert.ok(Array.isArray(groups));
  assert.deepEqual(
    groups[0].models,
    ids.map((id) => ({ name: id, alias: id })),
  );
});

test("malformed provider responses and service-account JSON never expose their content in errors", async () => {
  const malformed = await fixture(
    "kimi",
    "apiKey",
    { token: "synthetic-saved-token" },
    () =>
      new Response("synthetic-private-response", {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(malformed.mirror(), (error: unknown) => {
    assert.match(String(error), /Provider account configuration unavailable/);
    assert.equal(String(error).includes("synthetic-private-response"), false);
    return true;
  });
  assert.equal(malformed.calls.length, 0);
  const invalid = await fixture("vertex", "serviceAccount", {
    token: "unused",
    serviceAccount: "synthetic-private-json",
  });
  await assert.rejects(invalid.mirror(), (error: unknown) => {
    assert.match(String(error), /Provider account configuration unavailable/);
    assert.equal(String(error).includes("synthetic-private-json"), false);
    return true;
  });
  assert.equal(invalid.calls.length, 0);
});

test("the largest accepted model catalog reaches signed mirror ingress without truncation", async () => {
  for (const character of ["x", "\u0800"]) {
    const ids = Array.from(
      { length: 2000 },
      (_, index) => `${String(index).padStart(4, "0")}${character.repeat(252)}`,
    );
    const f = await fixture("openrouter", "apiKey", { token: "synthetic-saved-token" }, () =>
      Response.json({ data: ids.map((id) => ({ id })) }),
    );
    await f.mirror();
    const groups = f.configs.get("/v8/management/config/api-keys/openai-compatibility");
    assert.ok(Array.isArray(groups));
    assert.deepEqual(
      groups[0].models,
      ids.map((id) => ({ name: id, alias: id })),
    );
  }
});

const gatewayFields = (baseUrl: string, models = "emulated-opus, emulated-sol,emulated-opus") => ({
  baseUrl,
  models,
  token: "synthetic-saved-token",
});

test("a custom endpoint mirrors its own address and only the model names it was given", async () => {
  const anthropic = await fixture("custom", "anthropic", gatewayFields("https://gateway.example/"));
  await anthropic.mirror();
  const named = [
    { name: "emulated-opus", alias: "emulated-opus" },
    { name: "emulated-sol", alias: "emulated-sol" },
  ];
  assert.deepEqual(anthropic.configs.get("/v8/management/config/api-keys/claude"), [
    {
      "base-url": "https://gateway.example",
      models: named,
      keys: [{ id: reference, "api-key": "synthetic-saved-token" }],
    },
  ]);
  await anthropic.remove();
  assert.deepEqual(anthropic.configs.get("/v8/management/config/api-keys/claude"), []);

  // One trailing /v1 is the family's own path, so entering it does not double it.
  const versioned = await fixture(
    "custom",
    "anthropic",
    gatewayFields("https://gateway.example/v1"),
  );
  await versioned.mirror();
  const [versionedGroup] = versioned.configs.get("/v8/management/config/api-keys/claude") as [Json];
  assert.equal(versionedGroup["base-url"], "https://gateway.example");

  const openai = await fixture(
    "custom",
    "openai",
    gatewayFields("https://gateway.example/api/v1/"),
  );
  await openai.mirror();
  assert.deepEqual(openai.configs.get("/v8/management/config/api-keys/openai-compatibility"), [
    {
      name: `basalt-custom-${reference}`,
      "base-url": "https://gateway.example/api/v1",
      models: named,
      keys: [{ id: reference, "api-key": "synthetic-saved-token" }],
    },
  ]);
  await openai.remove();
  assert.deepEqual(openai.configs.get("/v8/management/config/api-keys/openai-compatibility"), []);
});

test("a custom endpoint refuses local, private and malformed addresses and bad model lists before any write", async () => {
  for (const baseUrl of [
    "http://gateway.example",
    "https://user:secret@gateway.example",
    "https://gateway.example/?key=1",
    "https://gateway.example/#x",
    "https://localhost",
    "https://api.localhost",
    "https://printer.local",
    "https://service.internal",
    "https://router.home.arpa",
    "https://nas.lan",
    "https://box.localdomain",
    "https://models.default.svc",
    "https://models.default.svc.cluster.local",
    "https://localhost..",
    "https://printer.local...",
    "https://intranet",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f.1",
    "https://10.1.2.3",
    "https://172.20.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://100.100.100.100",
    "https://0.0.0.0",
    "https://192.0.0.8",
    "https://192.0.2.1",
    "https://198.18.0.1",
    "https://198.19.255.254",
    "https://198.51.100.7",
    "https://203.0.113.9",
    "https://224.0.0.1",
    "https://255.255.255.255",
    "https://[::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "not a url",
  ]) {
    const f = await fixture("custom", "anthropic", gatewayFields(baseUrl));
    await assert.rejects(f.mirror(), /public https address/u, baseUrl);
    assert.deepEqual(f.calls, [], baseUrl);
  }
  for (const models of [
    " , ",
    "has space,fine",
    "tab\tinside",
    "ok?",
    "-leading",
    "a".repeat(129),
  ]) {
    const f = await fixture("custom", "openai", gatewayFields("https://gateway.example", models));
    await assert.rejects(f.mirror(), /model names/u, models);
    assert.deepEqual(f.calls, [], models);
  }
});

const customCheck = async (method: "anthropic" | "openai", fields: Record<string, string>) => {
  const health = providers.custom.health;
  assert.ok(health);
  const fetch = () => assert.fail("A custom endpoint's check must not send anything");
  const account = { id: "acc_unsaved", method, fields, read: fetch, headers: fetch, url: fetch };
  // SAFETY: the check reads only the method and fields; any other member fails the test.
  const run = health.run({
    account: account as never,
    fetch,
    signal: new AbortController().signal,
  });
  // The host's own classification turns what the check threw into what the form shows.
  const context = { accounts: Redacted.make({}) } as never;
  return Effect.runPromise(Effect.result(run.pipe(classifyAccountCheck(context))));
};

test("the connect form's check refuses a custom endpoint with the reason the person sees", async () => {
  for (const [baseUrl, models, reason] of [
    ["https://10.1.2.3", "emulated-opus", customEndpointRefusals.address],
    ["https://nas.lan/v1", "emulated-opus", customEndpointRefusals.address],
    ["https://gateway.example/?key=1", "emulated-opus", customEndpointRefusals.address],
    ["https://gateway.example", " , ", customEndpointRefusals.models],
    ["https://gateway.example", "has space,fine", customEndpointRefusals.models],
  ] as const) {
    for (const method of ["anthropic", "openai"] as const) {
      const result = await customCheck(method, gatewayFields(baseUrl, models));
      assert.ok(Result.isFailure(result), baseUrl);
      // The form shows a HostOperationFailed's own message after "Couldn't verify this <method>:".
      const carried = result.failure;
      assert.ok(Schema.is(HostOperationFailed)(carried), `${method} ${baseUrl}`);
      assert.equal(carried.source, "app");
      assert.equal(carried.message, reason, `${method} ${baseUrl} ${models}`);
    }
  }
  assert.match(customEndpointRefusals.address, /^Enter a public https address/u);
  assert.match(customEndpointRefusals.models, /^Enter one to 200 model names/u);
  for (const baseUrl of ["https://gateway.example", "https://gateway.example/api/v1/"])
    for (const method of ["anthropic", "openai"] as const)
      assert.ok(Result.isSuccess(await customCheck(method, gatewayFields(baseUrl))), baseUrl);
});
