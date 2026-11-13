import { test } from "node:test";
import assert from "node:assert/strict";
import { AppId } from "@executor-js/sdk";
import type { ConnectedAgent } from "@executor-js/mcp-auth/agents";
import { ConnectionId, type Connection } from "@executor-js/mcp-auth/connections";
import { GrantId } from "@executor-js/mcp-auth/grants";
import { obsidianTools } from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import {
  connectLabel,
  deviceSync,
  hasSyncTool,
  obsidianDevices,
  isStale,
  latestActivity,
  staleAfter,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-devices.ts";

const vault = AppId.make("app_fixture_vault");
const other = AppId.make("app_fixture_other");
// What Connect Obsidian creates: this one app, limited to the plugin's sync tools.
const connection = (id: string, app: AppId, apps?: readonly AppId[]): Connection =>
  ({
    id: ConnectionId.make(id),
    name: `Obsidian · ${id}`,
    policy: {
      apps: (apps ?? [app]).map((entry) => ({
        app: entry,
        runsAs: [{ kind: "app" }],
        tools: apps ? { kind: "all" } : { kind: "selected", names: obsidianTools },
      })),
    },
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
  }) as unknown as Connection;
const agent = (
  id: string,
  access: ConnectedAgent["access"],
  connectedAt: string,
  name: string | null = "Signalbox Obsidian Sync",
): ConnectedAgent => ({
  id: GrantId.make(id),
  name,
  connectedAt,
  lastActiveAt: null,
  access,
});
const through = (id: string) =>
  ({ kind: "connection", connection: ConnectionId.make(id), name: `Obsidian · ${id}` }) as const;

test("a vault's devices are the grants held through its own scoped connections", () => {
  const connections = [
    connection("mac", vault),
    connection("phone", vault),
    connection("x", other),
  ];
  const agents = [
    agent("g-phone", through("phone"), "2026-11-10T09:00:00.000Z"),
    agent("g-mac", through("mac"), "2026-11-10T08:30:00.000Z"),
    agent("g-other", through("x"), "2026-11-10T08:00:00.000Z"),
    agent("g-all", { kind: "all" }, "2026-11-10T07:00:00.000Z", "Claude"),
    agent("g-api", { kind: "api" }, "2026-11-10T07:00:00.000Z", "CLI"),
  ];
  const devices = obsidianDevices(vault, connections, agents);
  assert.deepEqual(
    devices.map((device) => [device.agent, device.connection, device.label]),
    [
      ["g-mac", "mac", "Obsidian device 1"],
      ["g-phone", "phone", "Obsidian device 2"],
    ],
  );
  assert.deepEqual(
    obsidianDevices(other, connections, agents).map((device) => device.label),
    ["Obsidian device"],
  );
});

test("a device that names itself keeps its name; unnamed ones are numbered among themselves", () => {
  const connections = [connection("a", vault), connection("b", vault), connection("c", vault)];
  const devices = obsidianDevices(vault, connections, [
    agent("g-a", through("a"), "2026-11-10T08:00:00.000Z"),
    agent("g-b", through("b"), "2026-11-10T09:00:00.000Z", "Studio MacBook"),
    agent("g-c", through("c"), "2026-11-10T10:00:00.000Z", null),
  ]);
  assert.deepEqual(
    devices.map((device) => device.label),
    ["Obsidian device 1", "Studio MacBook", "Obsidian device 2"],
  );
});

test("the header offers another device only once one syncs the vault, and returns after the last disconnects", () => {
  const connections = [connection("mac", vault)];
  const synced = obsidianDevices(vault, connections, [
    agent("g-mac", through("mac"), "2026-11-10T08:30:00.000Z"),
  ]);
  assert.equal(connectLabel(synced), "Connect another device");
  // Disconnect revokes the grant; the agents list no longer holds it.
  assert.equal(connectLabel(obsidianDevices(vault, connections, [])), "Connect Obsidian");
  // A connection whose plugin never approved holds no grant and is not a device.
  assert.equal(
    connectLabel(obsidianDevices(vault, [connection("pending", vault)], [])),
    "Connect Obsidian",
  );
});

test("a device's sync comes from the drive's record for its own grant, never another caller's", () => {
  const [mac, phone] = obsidianDevices(
    vault,
    [connection("mac", vault), connection("phone", vault)],
    [
      agent("g-mac", through("mac"), "2026-11-10T08:00:00.000Z"),
      agent("g-phone", through("phone"), "2026-11-10T09:00:00.000Z"),
    ],
  );
  const sync = {
    head: "h2",
    devices: [
      { agent: "g-mac", lastSyncAt: "2026-11-12T09:59:00.000Z", lastHead: "h2" },
      // An agent using the tools syncs too; it is not one of this vault's devices.
      { agent: "g-claude", lastSyncAt: "2026-11-12T09:58:00.000Z", lastHead: "h1" },
    ],
  };
  assert.deepEqual(deviceSync(sync, mac!), { at: "2026-11-12T09:59:00.000Z", current: true });
  // The phone hasn't synced since the drive began recording: no record, not stale.
  assert.equal(deviceSync(sync, phone!), null);
  assert.deepEqual(deviceSync({ ...sync, head: "h3" }, mac!), {
    at: "2026-11-12T09:59:00.000Z",
    current: false,
  });
  // Apps from before the drive reported syncs have no such tool; devices show without times.
  assert.equal(hasSyncTool([{ name: "listNotes" }, { name: "history" }]), false);
  assert.equal(hasSyncTool([{ name: "devices" }]), true);
});

test("an agent's wider connection that includes the vault app is not a device", () => {
  const devices = obsidianDevices(
    vault,
    [connection("mac", vault), connection("claude", vault, [vault, other])],
    [
      agent("g-mac", through("mac"), "2026-11-10T08:00:00.000Z"),
      agent("g-claude", through("claude"), "2026-11-10T07:00:00.000Z", "Claude Code"),
    ],
  );
  assert.deepEqual(
    devices.map((device) => device.agent),
    ["g-mac"],
  );
});

test("a single-app connection is a device only when scoped to sync tools and run as the app", () => {
  const scoped = (id: string, tools: unknown, runsAs: unknown = [{ kind: "app" }]) =>
    ({
      ...connection(id, vault),
      policy: { apps: [{ app: vault, runsAs, tools }] },
    }) as unknown as Connection;
  const devices = obsidianDevices(
    vault,
    [
      scoped("all", { kind: "all" }),
      scoped("extra", { kind: "selected", names: [...obsidianTools, "deleteNote"] }),
      scoped("user", { kind: "selected", names: obsidianTools }, [{ kind: "user" }]),
      scoped("plugin", { kind: "selected", names: obsidianTools.slice(0, 5) }),
    ],
    ["all", "extra", "user", "plugin"].map((id) =>
      agent(`g-${id}`, through(id), "2026-11-10T08:00:00.000Z"),
    ),
  );
  assert.deepEqual(
    devices.map((device) => device.agent),
    ["g-plugin"],
  );
});

test("a device's sync against a vault with no head yet is never current", () => {
  const [mac] = obsidianDevices(
    vault,
    [connection("mac", vault)],
    [agent("g-mac", through("mac"), "2026-11-10T08:00:00.000Z")],
  );
  assert.deepEqual(
    deviceSync(
      {
        head: null,
        devices: [{ agent: "g-mac", lastSyncAt: "2026-11-12T09:59:00.000Z", lastHead: "h1" }],
      },
      mac!,
    ),
    { at: "2026-11-12T09:59:00.000Z", current: false },
  );
});

test("a vault's card shows the newest activity any of its devices reports, by each row's rule", () => {
  const device = (agent: string, lastActiveAt: string | null) => ({
    agent: GrantId.make(agent),
    connection: ConnectionId.make(`conn_${agent}`),
    label: agent,
    connectedAt: "2026-11-10T08:00:00.000Z",
    lastActiveAt,
  });
  const mac = device("mac", "2026-11-12T08:00:00.000Z");
  const phone = device("phone", "2026-11-12T09:00:00.000Z");
  const idle = device("idle", null);

  assert.equal(latestActivity([idle], undefined), null);
  assert.deepEqual(latestActivity([mac, phone, idle], undefined), {
    kind: "active",
    at: "2026-11-12T09:00:00.000Z",
  });
  // A device's own sync record replaces its grant activity, as its Accounts row does.
  const sync = {
    head: "h2",
    devices: [{ agent: "mac", lastSyncAt: "2026-11-12T10:00:00.000Z", lastHead: "h1" }],
  };
  assert.deepEqual(latestActivity([mac, phone], sync), {
    kind: "synced",
    at: "2026-11-12T10:00:00.000Z",
    current: false,
  });
  // An older sync record never hides a newer sign of life from another device.
  const old = {
    head: "h2",
    devices: [{ agent: "mac", lastSyncAt: "2026-11-12T07:00:00.000Z", lastHead: "h2" }],
  };
  assert.deepEqual(latestActivity([mac, phone], old), {
    kind: "active",
    at: "2026-11-12T09:00:00.000Z",
  });
});

test("a device turns stale once it has been idle more than two days", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(staleAfter, 2 * 24 * 60 * 60 * 1000);
  assert.equal(isStale(null, now), false);
  assert.equal(isStale({ kind: "active", at: at(staleAfter) }, now), false);
  assert.equal(isStale({ kind: "active", at: at(staleAfter + 1) }, now), true);
  assert.equal(isStale({ kind: "synced", at: at(staleAfter + 1), current: true }, now), true);
});

test("devices that report the same name are numbered, as older unnamed ones always were", () => {
  const connections = [
    connection("mac", vault),
    connection("phone", vault),
    connection("pad", vault),
  ];
  const devices = obsidianDevices(vault, connections, [
    agent("g-mac", through("mac"), "2026-11-10T09:00:00.000Z", "Alex MacBook Pro"),
    agent("g-phone", through("phone"), "2026-11-10T10:00:00.000Z", "iPhone"),
    agent("g-pad", through("pad"), "2026-11-10T11:00:00.000Z", "iPhone"),
  ]);
  assert.deepEqual(
    devices.map((device) => device.label),
    ["Alex MacBook Pro", "iPhone 1", "iPhone 2"],
  );
});
