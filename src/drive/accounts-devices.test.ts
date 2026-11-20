// The Accounts tab's device list over grant storage the grant store wrote itself (see
// test/grant-fixture.ts). The host's connection store reads the person's connections and agents as
// the dashboard's API does, and the dashboard's own rule picks the vault's devices from them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionId, type ConnectionInput } from "@executor-js/mcp-auth/connections";
import { AppId, ToolName } from "@executor-js/sdk/core";
import { pgliteLayer } from "fumadb-effect/pglite";
import { vaultDeviceGrants } from "../../.upstream/apps/hosted/server/src/implementation/vault-device-grants.ts";
import { obsidianConnectionInput } from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import { obsidianDevices } from "../../.upstream/apps/hosted/web/src/contracts/obsidian-devices.ts";
import { grantStore } from "./test/grant-fixture.ts";

const vault = { id: AppId.make("app_fixture_vault"), name: "Personal" };

/** A connection to the vault app alone, run as the app, with the tools its owner chose. */
const scoped = (id: string, tools: ConnectionInput["apps"][number]["tools"]): ConnectionInput => ({
  id: ConnectionId.make(id),
  name: `Connection ${id}`,
  apps: [{ app: vault.id, runsAs: [{ kind: "app" }], tools }],
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(pgliteLayer())));

test("the Accounts tab lists a vault's Connect Obsidian devices, never an agent's connection with only sync tools", async () => {
  const { ids, listed, issuedToDevice, shown, kept } = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const grants = yield* grantStore("org_accounts_devices");
      // Connect Obsidian's connection for this vault; two devices connect through it.
      const obsidian = yield* grants.connection(
        obsidianConnectionInput(vault, ConnectionId.make("obsidian-vault")),
      );
      const mac = yield* grants.connectDevice(obsidian, "MacBook");
      const phone = yield* grants.connectDevice(obsidian, "iPhone");
      // A device whose connection selects every tool, as after its owner widens it, is a device still.
      const tablet = yield* grants.connectDevice(
        yield* grants.connection(scoped("obsidian-widened", { kind: "all" })),
        "iPad",
      );
      // Agents: one whose own connection selects only the sync tools listNotes and readNote, one
      // connected through Connect Obsidian's own connection, and one with every tool. The first two
      // hold a device's tools, or fewer; only how each grant was issued tells them from a device.
      const reader = yield* grants.connectAgent(
        (yield* grants.connection(
          scoped("vault-reader", {
            kind: "selected",
            names: [ToolName.make("listNotes"), ToolName.make("readNote")],
          }),
        )).url,
        "Reader",
      );
      const borrower = yield* grants.connectAgent(obsidian.url, "Agent");
      const everything = yield* grants.connectAgent(
        (yield* grants.connection(scoped("agent-tools", { kind: "all" }))).url,
        "Agent",
      );
      const ids = { mac, phone, tablet, reader, borrower, everything };
      const { connections, agents } = yield* grants.listings();
      return {
        ids,
        listed: agents.map((agent) => agent.id),
        issuedToDevice: agents.filter((agent) => agent.issuedToDevice).map((agent) => agent.id),
        shown: obsidianDevices(vault.id, connections, agents).map((device) => device.agent),
        // What devices() keeps of the same grants, read from the same grant storage.
        kept: yield* vaultDeviceGrants(sql, vault.id, Object.values(ids)),
      };
    }),
  );
  // The listing holds every grant, the agents' included.
  assert.deepEqual([...listed].sort(), Object.values(ids).sort());
  const devices = [ids.mac, ids.phone, ids.tablet].sort();
  assert.deepEqual([...shown].sort(), devices);
  // The Accounts tab and devices() keep the same grants, and the listing says why.
  assert.deepEqual([...shown].sort(), [...kept].sort());
  assert.deepEqual([...issuedToDevice].sort(), devices);
});
