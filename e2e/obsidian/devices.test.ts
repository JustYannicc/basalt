import { test } from "node:test";
import assert from "node:assert/strict";
import { AppId } from "@executor-js/sdk";
import type { ConnectedAgent } from "@executor-js/mcp-auth/agents";
import { ConnectionId, type Connection } from "@executor-js/mcp-auth/connections";
import { GrantId } from "@executor-js/mcp-auth/grants";
import {
  connectLabel,
  obsidianDevices,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-devices.ts";

const vault = AppId.make("app_fixture_vault");
const other = AppId.make("app_fixture_other");
const connection = (id: string, app: AppId): Connection =>
  ({
    id: ConnectionId.make(id),
    name: `Obsidian · ${id}`,
    policy: { apps: [{ app, runsAs: [{ kind: "app" }], tools: { kind: "all" } }] },
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
