import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, inventory, removeAll } from "./cloudflare.ts";

const stage = "test-route-scratch-1" as const;
const accountId = "acct";
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

/** An account with the stage's Worker, application and image, beside a foreign repository. */
function fakeAccount({ refuseImageDelete = false } = {}) {
  const repositories = new Map<string, Map<string, string>>([
    [`${accountId}/basalt-route-scratch-1-route-gateway`, new Map([["build1", digest(1)]])],
    // Another stage's image, and one that only shares the stage's prefix: neither is the stage's.
    [
      `${accountId}/basalt-rehearsal-pool-test-rehearsal-1-abcdefghijklmnop`,
      new Map([["v1", digest(2)]]),
    ],
    [`${accountId}/basalt-route-scratch-1-route-gateway-other`, new Map([["v1", digest(3)]])],
  ]);
  const applications = [{ id: "app-1", name: "basalt-route-scratch-1-route-gateway" }];
  const scripts = [{ id: "basalt-route-scratch-1-pool" }];
  const namespaces = [{ id: "ns-1", name: "RouteGateway", script: "basalt-route-scratch-1-pool" }];
  const credentials: unknown[] = [];
  const deletes: string[] = [];
  const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
  const listed = (rows: unknown[]) =>
    json({ success: true, result: rows, result_info: { total_pages: 1 } });
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.hostname === "api.cloudflare.com") {
      const path = url.pathname.replace(`/client/v4/accounts/${accountId}/`, "");
      if (path === "containers/registries/registry.cloudflare.com/credentials") {
        credentials.push(JSON.parse(String(init.body)));
        return json({ success: true, result: { username: "u", password: "p" } });
      }
      if (method === "GET" && path === "containers/applications") return listed(applications);
      if (method === "GET" && path === "workers/scripts") return listed(scripts);
      if (method === "GET" && path === "workers/durable_objects/namespaces")
        return listed(namespaces);
      if (method === "DELETE") {
        deletes.push(path);
        if (path === "containers/applications/app-1") applications.splice(0);
        if (path.startsWith("workers/scripts/")) scripts.splice(0);
        if (path === "workers/durable_objects/namespaces/ns-1") namespaces.splice(0);
        return json({ success: true, result: null });
      }
    }
    if (url.hostname === "registry.cloudflare.com") {
      assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${btoa("u:p")}`);
      const path = decodeURIComponent(url.pathname.replace("/v2/", ""));
      if (path === "_catalog") return json({ repositories: [...repositories.keys()] });
      const match = /^(.+)\/(tags\/list|manifests\/(.+))$/u.exec(path);
      const tags = match && repositories.get(match[1]!);
      if (!tags) return new Response(null, { status: 404 });
      if (match![2] === "tags/list") return json({ tags: [...tags.keys()] });
      const reference = match![3]!;
      const found = [...tags.entries()].find(([tag, at]) => tag === reference || at === reference);
      if (!found) return new Response(null, { status: 404 });
      if (method === "DELETE") {
        deletes.push(`registry:${match![1]}`);
        if (refuseImageDelete) return new Response(null, { status: 500 });
        tags.delete(found[0]);
        return new Response(null, { status: 202 });
      }
      return json({}, { headers: { "docker-content-digest": found[1] } });
    }
    throw new Error(`unexpected request ${method} ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  return { account: { accountId, token: "t", fetch: fetcher }, repositories, credentials, deletes };
}

test("the read-back sees the stage's image, and only the stage's", async () => {
  const { account } = fakeAccount();
  const found = await inventory(account, stage);
  assert.deepEqual(
    found.images.map((image) => image.repository),
    [`${accountId}/basalt-route-scratch-1-route-gateway`],
  );
  assert.equal(empty(found), false);
});

test("a destroy deletes the stage's image and leaves every other repository alone", async () => {
  const { account, repositories, credentials, deletes } = fakeAccount();
  const failed = await removeAll(account, stage, await inventory(account, stage));
  assert.deepEqual(failed, []);
  assert.equal(repositories.get(`${accountId}/basalt-route-scratch-1-route-gateway`)!.size, 0);
  assert.equal(
    repositories.get(`${accountId}/basalt-rehearsal-pool-test-rehearsal-1-abcdefghijklmnop`)!.size,
    1,
  );
  assert.equal(
    repositories.get(`${accountId}/basalt-route-scratch-1-route-gateway-other`)!.size,
    1,
  );
  assert.ok(deletes.every((path) => !path.includes("rehearsal") && !path.endsWith("-other")));
  assert.equal(empty(await inventory(account, stage)), true);
  // Reading asks only to pull; only the delete asks for push, and both expire in 15 minutes.
  assert.deepEqual(
    credentials.map((body) => (body as { permissions: string[] }).permissions.join("+")),
    ["pull", "pull+push", "pull"],
  );
  assert.ok(
    credentials.every((body) => (body as { expiration_minutes: number }).expiration_minutes === 15),
  );
});

test("the read-back fails while an image remains", async () => {
  const { account } = fakeAccount({ refuseImageDelete: true });
  const failed = await removeAll(account, stage, await inventory(account, stage));
  assert.deepEqual(failed, ["image"]);
  const after = await inventory(account, stage);
  assert.equal(after.applications.length + after.scripts.length + after.namespaces.length, 0);
  assert.equal(after.images.length, 1);
  assert.equal(empty(after), false);
});
