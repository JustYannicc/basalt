import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { ComputerHome, digest } from "./computer-home.ts";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import { BackendFailure } from "./json.ts";

type Json = Record<string, unknown>;
type Call = { path: string; method: string; body?: Json };

test("an expired provisioning budget prevents late user creation when Home ignores abort", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const calls: string[] = [];
  const home = new ComputerHome(new HomeClient(async (path, init) => {
    assert.equal(init?.signal, controller.signal);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    entered();
    await gate;
    return Response.json({ users: [] });
  }));
  const provisioning = home.user("fake-member", undefined, controller.signal);
  await started;
  controller.abort();
  release();
  await assert.rejects(provisioning, { name: "AbortError" });
  assert.deepEqual(calls, ["GET /v8/management/users"]);
});

class FakeHomeServer {
  calls: Call[] = [];
  users: Json[] = [];
  groups: Json[] = [];
  apiKeys: Json[] = [];
  nextUserId = 19;
  nextGroupId = 31;
  nextKeyId = 73;
  deleteStatus = 200;
  deleteBody: Json = { status: "ok" };
  groupReads = 0;
  readGroups: ((read: number) => Json[]) | undefined;

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Json : undefined;
    this.calls.push({ path, method, ...(body ? { body } : {}) });
    const url = new URL(`https://home.example${path}`);
    const endpoint = url.pathname.slice("/v8/management".length);
    if (endpoint === "/users") {
      if (method === "POST") {
        const user = { id: this.nextUserId++, ...body };
        this.users.push(user);
        return Response.json({ user });
      }
      return Response.json({ users: this.users });
    }
    if (endpoint === "/channel-groups") {
      if (method === "POST") {
        const group = { id: this.nextGroupId++, ...body };
        this.groups.push(group);
        return Response.json({ channel_group: group });
      }
      return Response.json({ channel_groups: this.readGroups?.(++this.groupReads) ?? this.groups });
    }
    if (endpoint === "/access/api-keys") {
      if (method === "POST") {
        const keyId = this.nextKeyId++;
        this.apiKeys.push({ ...body, id: keyId, api_key_id: keyId });
        return Response.json({ api_key: { id: keyId, api_key_id: keyId, user_id: body?.user_id } }, { status: 201 });
      }
      if (method === "PATCH") return Response.json({ status: "ok" });
      if (method === "DELETE") return Response.json(this.deleteBody, { status: this.deleteStatus });
      return Response.json({ items: this.apiKeys });
    }
    throw new Error(`Unexpected Home request ${method} ${endpoint}`);
  };

  client(onProductEvent?: (event: string, accountId: string) => void) { return new ComputerHome(new HomeClient(this.fetch), onProductEvent); }
}

test("Home user identity is stable for a tools user and defaults to uncapped credits", async () => {
  const server = new FakeHomeServer();
  const toolsUserId = "tools-user-42";
  const first = await server.client().user(toolsUserId);
  const second = await server.client().user(toolsUserId);
  const expectedUsername = `${brand.setup.id}-${await digest(toolsUserId)}`;

  assert.equal(first, second);
  assert.equal(server.users.length, 1);
  assert.equal(server.users[0]!.username, expectedUsername);
  assert.ok(!String(server.users[0]!.username).includes(toolsUserId));
  assert.deepEqual(server.calls.filter((call) => call.method === "POST").map((call) => call.body), [
    { username: expectedUsername, credits_unlimited: true },
  ]);
  assert.equal(Object.hasOwn(server.users[0]!, "credits"), false);
});

test("mint creates the pool group before one nonempty channel-scoped Home key", async () => {
  const server = new FakeHomeServer();
  const home = server.client();
  const computerId = "computer-uuid";
  const result = await home.mint("tools-user-42", "pool-a", computerId);
  const groupCreate = server.calls.findIndex((call) => call.path === "/v8/management/channel-groups" && call.method === "POST");
  const keyCreate = server.calls.findIndex((call) => call.path === "/v8/management/access/api-keys" && call.method === "POST");
  assert.ok(groupCreate >= 0);
  assert.ok(keyCreate > groupCreate);

  const key = server.calls[keyCreate]!.body!;
  assert.equal(key.display_name, `${brand.setup.id}:${computerId}`);
  assert.equal(key.user_id, result.userId);
  assert.deepEqual(key.channels, [31]);
  assert.ok(Array.isArray(key.channels) && key.channels.length > 0);
  assert.deepEqual(key.model_groups, []);
  assert.equal(key.api_key, result.key);
  assert.equal(result.keyId, 73);
  assert.equal(server.calls.filter((call) => call.path === "/v8/management/access/api-keys" && call.method === "POST").length, 1);
});

test("setup-created pools emit once after Home confirms the durable group", async () => {
  const server = new FakeHomeServer();
  const events: [string, string][] = [];
  const home = server.client((event, accountId) => events.push([event, accountId]));

  await home.mint("tools-user-42", "pool-a", "computer-one");
  await home.mint("tools-user-42", "pool-a", "computer-two");

  assert.deepEqual(events, [["pool_created", "tools-user-42"]]);
});

test("rebind reports a pool created for the signed setup person", async () => {
  const server = new FakeHomeServer();
  const events: [string, string][] = [];
  await server.client((event, accountId) => events.push([event, accountId])).rebind(73, "pool-b", "tools-user-42");
  assert.deepEqual(events, [["pool_created", "tools-user-42"]]);
});

test("rebind patches the same Home key after resolving the destination group", async () => {
  const server = new FakeHomeServer();
  server.users.push({ id: 19, username: `${brand.setup.id}-${await digest("tools-user-42")}` });
  const home = server.client();
  await home.rebind(73, "pool-b");
  const groupCreate = server.calls.findIndex((call) => call.path === "/v8/management/channel-groups" && call.method === "POST");
  const keyPatch = server.calls.findIndex((call) => call.path === "/v8/management/access/api-keys" && call.method === "PATCH");
  assert.ok(groupCreate >= 0);
  assert.ok(keyPatch > groupCreate);
  assert.deepEqual(server.calls[keyPatch]!.body, { api_key_id: 73, channels: [31] });
  assert.equal(Object.hasOwn(server.calls[keyPatch]!.body!, "api_key"), false);
  assert.equal(server.calls.some((call) => call.method === "POST" && call.path === "/v8/management/access/api-keys"), false);
});

for (const operation of ["mint", "rebind"] as const) {
  const write = (home: ComputerHome, pool: string) => operation === "mint"
    ? home.mint("tools-user-42", pool, "computer-uuid") : home.rebind(73, pool);
  const noKeyWrite = (server: FakeHomeServer) => assert.equal(server.calls.some((call) =>
    call.path === "/v8/management/access/api-keys" && ["POST", "PATCH"].includes(call.method)), false);

  test(`${operation} refuses an empty pool before creating a group or changing a key`, async () => {
    for (const pool of ["", "   "]) {
      const server = new FakeHomeServer();
      await assert.rejects(write(server.client(), pool));
      noKeyWrite(server);
      assert.equal(server.calls.some((call) => call.path.endsWith("/channel-groups")), false);
    }
  });

  test(`${operation} refuses a missing group even when group creation reports success`, async () => {
    const server = new FakeHomeServer();
    server.readGroups = () => [];
    await assert.rejects(write(server.client(), "pool-a"));
    noKeyWrite(server);
    assert.ok(server.calls.some((call) => call.path.endsWith("/channel-groups") && call.method === "POST"));
  });

  test(`${operation} refuses an empty or invalid group id`, async () => {
    for (const groupId of [undefined, null, "", [], 0, -1]) {
      const server = new FakeHomeServer();
      server.groups = [{ id: groupId, channel_name: `${poolGroupPrefix}pool-a` }];
      await assert.rejects(write(server.client(), "pool-a"));
      noKeyWrite(server);
    }
  });

  test(`${operation} refuses a group that disappears or changes pool before the key write`, async () => {
    for (const remaining of [[], [{ id: 31, channel_name: `${poolGroupPrefix}other-pool` }]]) {
      const server = new FakeHomeServer();
      server.readGroups = (read) => read === 1
        ? [{ id: 31, channel_name: `${poolGroupPrefix}pool-a` }] : remaining;
      await assert.rejects(write(server.client(), "pool-a"));
      noKeyWrite(server);
      assert.equal(server.groupReads, 2);
    }
  });
}

test("interrupted mint recovery looks up only the computer display tag", async () => {
  const server = new FakeHomeServer();
  const computerId = "computer-uuid";
  server.apiKeys = [
    { api_key_id: 91, display_name: `${brand.setup.id}:${computerId}` },
    { api_key_id: 92, display_name: `${brand.setup.id}:another-computer` },
    { api_key_id: 93, display_name: "unrelated-key" },
  ];
  assert.deepEqual(await server.client().find(computerId), [91]);
  assert.deepEqual(server.calls.map((call) => [call.method, call.path]), [["GET", "/v8/management/access/api-keys"]]);
});

test("Home's exact missing-key DELETE error is treated as already revoked", async () => {
  const server = new FakeHomeServer();
  const home = server.client();
  server.deleteStatus = 404;
  server.deleteBody = { error: "api_key_not_found" };
  await home.revoke(73);
  assert.deepEqual(server.calls.at(-1), {
    path: "/v8/management/access/api-keys?id=73", method: "DELETE",
  });

});

test("other Home DELETE errors stay failures", async () => {
  const server = new FakeHomeServer();
  const home = server.client();
  server.deleteStatus = 404;
  server.deleteBody = { error: "not_found" };
  await assert.rejects(home.revoke(73), (error: unknown) => error instanceof BackendFailure && error.backendStatus === 404);
  server.deleteStatus = 500;
  server.deleteBody = { error: "internal_error" };
  await assert.rejects(home.revoke(73), (error: unknown) => error instanceof BackendFailure && error.backendStatus === 500);
});
