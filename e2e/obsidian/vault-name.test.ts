import { test } from "node:test";
import assert from "node:assert/strict";
import { AppId } from "@executor-js/sdk";
import { ConnectionId, type Connection } from "@executor-js/mcp-auth/connections";
import { obsidian } from "../../src/catalog/obsidian/index.ts";
import { obsidianTools } from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import {
  obsidianDefaultName,
  vaultApp,
  vaultRename,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-vault-rename.ts";

const vault = AppId.make("app_fixture_vault");
const connection = (tools: { kind: "all" } | { kind: "selected"; names: readonly string[] }) =>
  ({
    id: ConnectionId.make("fixture-device"),
    name: "Obsidian · Obsidian",
    policy: { apps: [{ app: vault, runsAs: [{ kind: "app" }], tools }] },
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
  }) as unknown as Connection;

test("only a device's own vault connection names an app", () => {
  assert.equal(vaultApp(connection({ kind: "selected", names: obsidianTools })), vault);
  // An agent's broader connection to the same app is not a device of the vault.
  assert.equal(vaultApp(connection({ kind: "all" })), undefined);
});

test("a vault app is named after its vault only while it has the catalog's name", () => {
  // The default the dashboard installs is the catalog entry's own name.
  assert.equal(obsidianDefaultName, obsidian.entry.name);
  assert.deepEqual(vaultRename({ name: "Obsidian" }, " Personal "), {
    name: "Personal",
    expectedName: "Obsidian",
  });
  // A name someone chose stays, and a blank report changes nothing.
  assert.equal(vaultRename({ name: "Work" }, "Personal"), undefined);
  assert.equal(vaultRename({ name: "Obsidian" }, "  "), undefined);
});
