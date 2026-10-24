import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { ComputerHome, digest } from "./computer-home.ts";
import { HomeClient } from "./control.ts";
import { BackendFailure } from "./json.ts";

type Json = Record<string, unknown>;
type Call = { path: string; method: string; body?: Json };

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
      return Response.json({ channel_groups: this.groups });
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

  client() { return new ComputerHome(new HomeClient(this.fetch)); }
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
