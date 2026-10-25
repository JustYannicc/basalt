import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudflareArtifactsApi,
  deleteEuNamespace,
  ensureEuNamespace,
  type ArtifactsApi,
} from "./ensure-artifacts.ts";

function fixture(initial: { namespaces?: Array<{ namespace: string; jurisdiction: string }>; repos?: string[] } = {}) {
  const calls: string[] = [];
  const namespaces = [...(initial.namespaces ?? [])];
  const repos = [...(initial.repos ?? [])];
  const api: ArtifactsApi = {
    async listNamespaces(cursor) {
      calls.push(`namespaces:${cursor ?? ""}`);
      return cursor ? { result: [] } : { result: namespaces.map((namespace) => ({ ...namespace })) };
    },
    async createNamespace(name) {
      calls.push(`create:${name}`);
      const namespace = { namespace: name, jurisdiction: "eu" };
      namespaces.push(namespace);
      return namespace;
    },
    async deleteNamespace(name) {
      calls.push(`delete-namespace:${name}`);
      const index = namespaces.findIndex((item) => item.namespace === name);
      if (index >= 0) namespaces.splice(index, 1);
    },
    async listRepositories(namespace, cursor) {
      calls.push(`repos:${namespace}:${cursor ?? ""}`);
      return cursor ? { result: [] } : { result: repos.map((name) => ({ name })) };
    },
    async deleteRepository(namespace, name) {
      calls.push(`delete-repo:${namespace}:${name}`);
      const index = repos.indexOf(name);
      if (index >= 0) repos.splice(index, 1);
    },
    async listRepositoryTokens(namespace, name, cursor) {
      calls.push(`tokens:${namespace}:${name}:${cursor ?? ""}`);
      return { result: [{ id: `${name}-token` }] };
    },
    async deleteToken(namespace, token) {
      calls.push(`delete-token:${namespace}:${token}`);
    },
  };
  return { api, calls, namespaces, repos };
}

test("refuses an existing namespace outside the EU without mutating it", async () => {
  const { api, calls } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "unrestricted" }],
  });
  await assert.rejects(
    ensureEuNamespace(api, "basalt-preview-pr-1419-apps"),
    /immutable EU jurisdiction/,
  );
  assert.deepEqual(calls, ["namespaces:"]);
});

test("checks every page before creating a missing EU namespace", async () => {
  const { api, calls } = fixture();
  api.listNamespaces = async (cursor) => {
    calls.push(`namespaces:${cursor ?? ""}`);
    return cursor
      ? { result: [] }
      : { result: [], result_info: { cursor: "next" } };
  };
  await ensureEuNamespace(api, "basalt-preview-pr-1419-apps");
  assert.deepEqual(calls, ["namespaces:", "namespaces:next", "create:basalt-preview-pr-1419-apps"]);
});

test("deletes every repository before deleting and verifying the namespace", async () => {
  const { api, calls } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "eu" }],
    repos: ["apps", "workspace"],
  });
  await deleteEuNamespace(api, "basalt-preview-pr-1419-apps", { wait: async () => {} });
  assert.deepEqual(calls, [
    "namespaces:",
    "repos:basalt-preview-pr-1419-apps:",
    "tokens:basalt-preview-pr-1419-apps:apps:",
    "delete-token:basalt-preview-pr-1419-apps:apps-token",
    "delete-repo:basalt-preview-pr-1419-apps:apps",
    "tokens:basalt-preview-pr-1419-apps:workspace:",
    "delete-token:basalt-preview-pr-1419-apps:workspace-token",
    "delete-repo:basalt-preview-pr-1419-apps:workspace",
    "repos:basalt-preview-pr-1419-apps:",
    "delete-namespace:basalt-preview-pr-1419-apps",
    "namespaces:",
  ]);
});

test("deleting an already absent namespace is idempotent", async () => {
  const { api, calls } = fixture();
  await deleteEuNamespace(api, "basalt-preview-pr-1419-apps");
  assert.deepEqual(calls, ["namespaces:"]);
});

test("namespace removal fails while provider readback still finds repositories", async () => {
  const { api } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "eu" }],
    repos: ["still-here"],
  });
  api.deleteRepository = async () => {};
  await assert.rejects(
    deleteEuNamespace(api, "basalt-preview-pr-1419-apps", {
      attempts: 2,
      delayMs: 0,
      wait: async () => {},
    }),
    /repositories are still present/,
  );
});

test("the HTTP client reads Cloudflare's paginated list envelope before creating an EU namespace", async () => {
  // Shapes from the Artifacts REST API reference: list routes return `result` items and a `result_info` cursor.
  const requests: string[] = [];
  const pages: Record<string, unknown> = {
    "": { result: [{ namespace: "other", jurisdiction: "eu" }], success: true, errors: [], messages: [], result_info: { cursor: "page-2", per_page: 1, count: 1 } },
    "page-2": { result: [], success: true, errors: [], messages: [], result_info: { cursor: "", per_page: 1, count: 0 } },
  };
  const api = cloudflareArtifactsApi("account", "fixture-token", async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}${url.search}`);
    if (init?.method === "GET") return Response.json(pages[url.searchParams.get("cursor") ?? ""]);
    return Response.json({ result: { namespace: "basalt-apps", jurisdiction: "eu" }, success: true, errors: [], messages: [] });
  });
  await ensureEuNamespace(api, "basalt-apps");
  assert.deepEqual(requests, [
    "GET /client/v4/accounts/account/artifacts/namespaces?limit=200",
    "GET /client/v4/accounts/account/artifacts/namespaces?limit=200&cursor=page-2",
    "POST /client/v4/accounts/account/artifacts/namespaces",
  ]);
});
