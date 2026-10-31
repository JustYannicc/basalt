import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { HomeMembership } from "./home-membership.ts";

test("level repair detaches a revoked account from one pool without deleting the shared credential", async () => {
  const groups = [{ id: 1, channel_name: "signalbox-pool-a" }, { id: 2, channel_name: "signalbox-pool-b" }];
  const members = [
    { id: 1, channel_group_id: 1, auth_id: "shared" },
    { id: 2, channel_group_id: 2, auth_id: "shared" },
  ];
  const credentials = new Set(["shared", "new"]);
  const client = new HomeClient(async (path, init) => {
    const url = new URL(path, "http://home");
    const route = url.pathname.replace("/v8/management", "");
    assert.ok(!route.startsWith("/credentials"), "repair must never mutate the global credential");
    if (route === "/channel-groups") return Response.json({ channel_groups: groups });
    if (init?.method === "DELETE") {
      const id = Number(route.split("/").at(-1));
      const index = members.findIndex((member) => member.id === id);
      assert.ok(index >= 0);
      members.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { channel_group_id: number; auth_id: string };
      assert.ok(credentials.has(body.auth_id));
      members.push({ id: 3, ...body });
      return Response.json({});
    }
    return Response.json({ channel_group_details: members.filter((member) => String(member.channel_group_id) === url.searchParams.get("channel_group_id")) });
  });
  const membership = new HomeMembership(client);
  await membership.reconcile("a", ["new"]);
  await membership.reconcile("a", ["new"]);
  assert.deepEqual(await membership.actual("a"), ["new"]);
  assert.deepEqual(await membership.actual("b"), ["shared"]);
  assert.deepEqual([...credentials], ["shared", "new"]);
  groups.push({ id: 4, channel_name: "signalbox-pool-a" });
  members.push({ id: 4, channel_group_id: 4, auth_id: "shared" });
  await membership.reconcile("a", ["new"]);
  assert.deepEqual(await membership.actual("a"), ["new"], "a new group cannot hide behind an old group cache");
  assert.deepEqual(await membership.actual("b"), ["shared"]);
});
