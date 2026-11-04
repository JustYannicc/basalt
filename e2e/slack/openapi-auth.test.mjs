import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { defineApp } from "../../.upstream/packages/apps/src/index.ts";
import { createAppHandler, hostContext } from "../../.upstream/packages/apps/src/host.ts";
import { liveOpenapiRouter } from "../../.upstream/packages/apps/src/openapi.ts";

const source = JSON.parse(
  await readFile(new URL("../../src/catalog/slack.json", import.meta.url), "utf8"),
);
const directory = await mkdtemp(join(tmpdir(), "slack-auth-test-"));
let slackOpenapiCache, options;
try {
  for (const file of source.files.filter((file) =>
    ["openapi-auth.ts", "openapi.ts"].includes(file.path),
  ))
    await writeFile(join(directory, file.path), file.content);
  ({ options } = await import(pathToFileURL(join(directory, "openapi.ts")).href));
  const adapter = source.files.find((file) => file.path === "openapi-auth.ts");
  slackOpenapiCache = adapter
    ? (await import(pathToFileURL(join(directory, adapter.path)).href)).slackOpenapiCache
    : (cache) => cache;
} finally {
  await rm(directory, { recursive: true, force: true });
}

const token = (location, required = true) => ({
  name: "token",
  in: location,
  type: "string",
  required,
});
const operation = (name, parameters) => ({
  operationId: name,
  parameters,
  security: [{ slackAuth: [] }],
  responses: { 200: { description: "OK", schema: { type: "object" } } },
});
const document = {
  swagger: "2.0",
  info: { title: "Slack fixture", version: "1" },
  host: "slack.com",
  basePath: "/api",
  schemes: ["https"],
  paths: {
    "/auth.test": { get: operation("auth_test", [token("header")]) },
    "/users.profile.get": {
      get: operation("users_profile_get", [
        token("query"),
        { name: "user", in: "query", type: "string" },
      ]),
    },
    "/users.identity": { get: operation("users_identity", [token("query", false)]) },
    "/users.deletePhoto": { post: operation("users_deletePhoto", [token("formData")]) },
    "/reactions.add": {
      post: operation("reactions_add", [
        { name: "name", in: "formData", type: "string", required: true },
        token("header"),
      ]),
    },
  },
};

function memoryCache(fetch) {
  const values = new Map();
  const cache = {
    async get(input) {
      const key = JSON.stringify(input.key);
      if (!values.has(key))
        values.set(key, await input.load({ cache, fetch, signal: new AbortController().signal }));
      return values.get(key);
    },
    async read(key) {
      return values.get(JSON.stringify(key));
    },
    async readMany(keys) {
      return Promise.all(keys.map((key) => cache.read(key)));
    },
    async write(entries) {
      for (const { key, value } of entries) values.set(JSON.stringify(key), value);
    },
    async invalidate(key) {
      values.delete(JSON.stringify(key));
    },
    async revalidate(input) {
      await cache.invalidate(input.key);
      return cache.get(input);
    },
    forAccount() {
      return cache;
    },
  };
  return cache;
}

test("Slack schemas and account-bound requests need no caller token", async () => {
  for (const method of ["user", "token"]) {
    const requests = [];
    const credential = `synthetic-${method}`;
    const fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === options.source.url) return Response.json(document);
      requests.push(request);
      assert.equal(request.headers.get("authorization"), `Bearer ${credential}`);
      assert.equal(request.headers.get("token"), null);
      assert.equal(new URL(request.url).searchParams.has("token"), false);
      return Response.json({ ok: true, profile: {} });
    };
    const cache = memoryCache(fetch);
    const account = {
      method,
      fields: method === "user" ? { access_token: credential } : { token: credential },
    };
    const handlerFor = (cache) =>
      createAppHandler(
        defineApp({}, async () => ({
          tools: await liveOpenapiRouter({
            ...options,
            patches: [],
            cache,
            fetch,
            account,
          }),
        })),
      );
    const legacyHandler = handlerFor(cache);
    const handler = handlerFor(
      slackOpenapiCache ? slackOpenapiCache(cache, options.source.url) : cache,
    );
    const invoke = async (body, target = handler) => {
      const response = await target(
        new Request("https://app.invalid", { method: "POST", body: JSON.stringify(body) }),
        hostContext({ app: {} }),
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const legacy = await invoke({ operation: "inspect" }, legacyHandler);
    assert.match(JSON.stringify(legacy.tools[0].inputSchema), /"required":\["token"\]/);
    const catalog = await invoke({ operation: "inspect" });
    assert.equal(catalog.tools.length, 5);
    for (const tool of catalog.tools)
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"token"/);
    const profile = catalog.tools.find((tool) =>
      tool.name
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .includes("usersprofile"),
    );
    const auth = catalog.tools.find(
      (tool) => tool.name === "auth.test" || tool.name.startsWith("authTest."),
    );
    assert.ok(profile && auth);
    assert.deepEqual(
      await invoke({
        operation: "call",
        tool: profile.name,
        input: { query: { user: "U_SYNTHETIC" } },
      }),
      { ok: true, profile: {} },
    );
    await invoke({ operation: "call", tool: auth.name, input: {} });
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[0].url).searchParams.get("user"), "U_SYNTHETIC");
  }
});

test("Slack normalization leaves provider responses, anonymous parameters and failed downloads intact", async () => {
  const raw = {
    ...document,
    paths: {
      "/anonymous": { get: { ...operation("anonymous", [token("query")]), security: [] } },
      "/inherited": {
        get: { parameters: [token("query"), { name: "cursor", in: "query", type: "string" }] },
      },
    },
    security: [{ slackAuth: [] }],
  };
  const cache = memoryCache(async (input) =>
    input === options.source.url
      ? Response.json(raw, { headers: { "content-length": "999", "content-encoding": "gzip" } })
      : Response.json({ ok: true, token: "ordinary-response-field" }),
  );
  const wrapped = slackOpenapiCache(cache, options.source.url);
  const read = async (url, key) =>
    wrapped.get({
      key,
      freshFor: "1 minute",
      load: async ({ fetch }) => {
        const response = await fetch(url);
        return {
          body: await response.json(),
          length: response.headers.get("content-length"),
          encoding: response.headers.get("content-encoding"),
        };
      },
    });
  const normalized = await read(options.source.url, "definition");
  assert.deepEqual(normalized.body.paths["/anonymous"].get.parameters, [token("query")]);
  assert.deepEqual(normalized.body.paths["/inherited"].get.parameters, [
    { name: "cursor", in: "query", type: "string" },
  ]);
  assert.equal(normalized.length, null);
  assert.equal(normalized.encoding, null);
  assert.deepEqual((await read("https://slack.com/api/users.profile.get", "api")).body, {
    ok: true,
    token: "ordinary-response-field",
  });
  const failed = slackOpenapiCache(
    memoryCache(async () => new Response("upstream unavailable", { status: 503 })),
    options.source.url,
  );
  const status = await failed.get({
    key: "failed",
    freshFor: "1 minute",
    load: async ({ fetch }) => {
      const response = await fetch(options.source.url);
      assert.equal(await response.text(), "upstream unavailable");
      return response.status;
    },
  });
  assert.equal(status, 503);
});
