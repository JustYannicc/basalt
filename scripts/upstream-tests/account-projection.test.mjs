import assert from "node:assert/strict";
import { test } from "node:test";
import { savedAccountRows, savedBindingId } from "../../.upstream/apps/hosted/server/src/implementation/account-projection-view.ts";

const definition = { name: "Synthetic provider", auth: { apiKey: { type: "secrets" }, subscription: { type: "interactive" } },
  family: { id: "synthetic", name: "Synthetic", methods: { apiKey: { mechanism: "api-key" } } } };
const identity = { id: "verified-person", label: "Same identity", name: "Synthetic" };
const account = (id, method = "subscription") => ({ id, method, provider: "synthetic", label: "Same label",
  description: null, owner: "organization:synthetic", createdAt: new Date("2030-01-01"), identity });
const binding = (id, app = "pool-a", scope = "app", requirement = "subscriptions") => ({
  id: savedBindingId(app, scope, requirement, id), app, pool: app.startsWith("pool-") ? app : undefined,
  scope, requirement, access: { canUse: true, canManage: true }, linkedBy: { id: "owner", name: "Owner" },
  canRemove: true, canReconnect: false, signIn: { state: "saved", reconnectAt: null },
});
const input = (id, bindings = [], changes = {}) => ({ account: account(id), definition, bindings,
  signIn: { state: "saved", reconnectAt: null }, ...changes });

test("one saved account reached from its inventory and several native links has one row", () => {
  const a = binding("saved-a");
  const rows = savedAccountRows([input("saved-a"), input("saved-a", [a, a]),
    input("saved-a", [binding("saved-a", "pool-b"), binding("saved-a", "app-c")])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "saved-a");
  assert.equal(rows[0].bindings.length, 3);
  assert.deepEqual(rows[0].bindings.map((b) => b.app), ["pool-a", "pool-b", "app-c"]);
});

test("distinct saved IDs never merge despite identical verified identity, email or label", () => {
  const rows = savedAccountRows([input("saved-a", [binding("saved-a")]), input("saved-b", [binding("saved-b")])]);
  assert.deepEqual(rows.map((row) => row.id), ["saved-a", "saved-b"]);
  assert.equal(rows[0].identity.id, rows[1].identity.id);
  assert.equal(rows[0].label, rows[1].label);
});

test("native API and subscription accounts share a list without guessing their offering", () => {
  const rows = savedAccountRows([input("subscription"), input("api", [], { account: account("api", "apiKey") })]);
  assert.deepEqual(rows.map((row) => row.mechanism), ["interactive", "api-key"]);
  assert.ok(rows.every((row) => !Object.hasOwn(row, "offering")));
});

test("a pool filters by native membership and retains each member's other visible bindings", () => {
  const inputs = [input("saved-a", [binding("saved-a"), binding("saved-a", "pool-b")]),
    input("saved-b", [binding("saved-b", "pool-b")]), input("unlinked")];
  const all = savedAccountRows(inputs), pool = savedAccountRows(inputs, "pool-a");
  assert.deepEqual(pool, all.filter((row) => row.bindings.some((b) => b.pool === "pool-a")));
  assert.deepEqual(pool.map((row) => row.id), ["saved-a"]);
  assert.equal(pool[0].bindings.length, 2);
  assert.deepEqual(savedAccountRows(inputs, "unknown"), []);
});

test("unlinking from one pool preserves the saved ID and its remaining memberships", () => {
  const row = input("saved-a", [binding("saved-a", "pool-b")]);
  assert.deepEqual(savedAccountRows([row], "pool-a"), []);
  assert.equal(savedAccountRows([row], "pool-b")[0].id, "saved-a");
  assert.equal(savedAccountRows([input("saved-a")])[0].id, "saved-a");
});

test("binding actions remain per binding, and binding IDs distinguish scopes and requirements", () => {
  const links = [binding("saved-a"), { ...binding("saved-a", "pool-a", "user"), canRemove: false },
    binding("saved-a", "pool-a", "app", "another-slot")];
  const row = savedAccountRows([input("saved-a", links)])[0];
  assert.equal(new Set(row.bindings.map((b) => b.id)).size, 3);
  assert.deepEqual(row.bindings.map((b) => b.canRemove), [true, false, true]);
  assert.notEqual(savedBindingId("a/b", "app", "c", "d"), savedBindingId("a", "app", "b/c", "d"));
});

test("list health separates driver and app checks and carries no usage or usage permissions", () => {
  const health = { account: "saved-a", info: { email: "reported@example.test" }, infoCheckedAt: null,
    driver: { source: { kind: "driver", id: "synthetic", version: "1" }, checkable: true, check: { status: "healthy" } },
    apps: [{ app: "pool-a", checkable: true, check: { status: "healthy", current: true,
      displayStatus: { meters: [{ remaining: 0.5 }] } } }] };
  const row = savedAccountRows([input("saved-a", [], { health })])[0];
  assert.deepEqual(row.health.driver, health.driver);
  assert.equal(row.health.apps[0].check.status, "healthy");
  assert.equal(Object.hasOwn(row.health.apps[0].check, "displayStatus"), false);
  assert.equal(Object.hasOwn(row, "canInspect"), false);
  assert.equal(Object.hasOwn(row, "canRefresh"), false);
  assert.equal(row.identity, identity);
});

test("an app link cannot overwrite directory metadata or promote a health email into identity", () => {
  const { identity: _identity, ...withoutIdentity } = account("saved-a");
  const saved = input("saved-a", [], { account: withoutIdentity });
  const linked = input("saved-a", [binding("saved-a")], { account: { ...account("saved-a"), label: "Redacted" },
    health: { account: "saved-a", info: { email: "reported@example.test" }, infoCheckedAt: null, apps: [] } });
  const row = savedAccountRows([saved, linked])[0];
  assert.equal(row.label, "Same label");
  assert.equal(row.identity, undefined);
});
