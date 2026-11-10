import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { AppId, AppSlug, ToolName } from "@executor-js/sdk";
import { ConnectionId, ConnectionInput } from "@executor-js/mcp-auth/connections";
import {
  obsidianConnectionInput,
  obsidianConnectLink,
  obsidianTools,
  supportsObsidian,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import {
  basaltSyncReleaseStatus,
  basaltSyncRepository,
  basaltSyncTag,
  basaltSyncVersion,
  bratInstallLink,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-plugin.ts";
import { parseConnectLink, protocolAction } from "../../clients/obsidian/link.ts";
import manifest from "../../clients/obsidian/manifest.json" with { type: "json" };
import versions from "../../clients/obsidian/versions.json" with { type: "json" };

test("a renamed cloud app produces a plugin-readable link with only its exact tool scope", () => {
  const app = {
    id: AppId.make("app_fixture_notes"),
    slug: AppSlug.make("renamed-notes"),
    name: "My notes",
  };
  const policy = Schema.decodeUnknownSync(ConnectionInput)(
    obsidianConnectionInput(app, ConnectionId.make("fixture-device")),
  );
  assert.deepEqual(
    policy.apps.map((entry) => entry.app),
    [app.id],
  );
  assert.deepEqual(policy.apps[0]?.runsAs, [{ kind: "app" }]);
  assert.deepEqual(policy.apps[0]?.tools, { kind: "selected", names: obsidianTools });
  assert.deepEqual(policy.apps[0]?.events, { kind: "selected", names: [] });
  const link = new URL(
    obsidianConnectLink(app, "https://cloud.fixture.invalid/mcp?connection=fixture-device"),
  );
  // Obsidian answers "Unrecognized URI action" unless this is the action the plugin registers.
  assert.equal(link.protocol, "obsidian:");
  assert.equal(link.host || link.pathname.replace(/^\/+/u, ""), protocolAction);
  const request = parseConnectLink(Object.fromEntries(link.searchParams));
  assert.equal(request.config.appId, app.id);
  assert.equal(request.config.appSlug, app.slug);
  assert.equal(
    request.config.connection,
    "https://cloud.fixture.invalid/mcp?connection=fixture-device&elicitation_mode=native",
  );
  const all = obsidianTools.map((name) => ({ name: ToolName.make(name) }));
  assert.equal(supportsObsidian({ requirements: { drive: true, accounts: {} } }, all), true);
  assert.equal(
    supportsObsidian({ requirements: { drive: true, accounts: {} } }, all.slice(1)),
    false,
  );
  assert.equal(Boolean(supportsObsidian({ requirements: { accounts: {} } }, all)), false);
});

test("the dashboard installs the plugin release this checkout publishes", () => {
  assert.equal(basaltSyncVersion, manifest.version);
  assert.equal(Object.hasOwn(versions, manifest.version), true);
  assert.equal(manifest.id, protocolAction);
  // The release workflow, the dashboard's BRAT link and the plugin agree on one tag per version.
  assert.equal(basaltSyncTag, `${manifest.id}-${manifest.version}`);
  const release = readFileSync(
    new URL("../../.github/workflows/obsidian-plugin-release.yml", import.meta.url),
    "utf8",
  );
  assert.ok(release.includes(`tag="${manifest.id}-$version"`));
  assert.equal(basaltSyncRepository("https://github.com/owner/repo"), "owner/repo");
  assert.equal(basaltSyncRepository("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(basaltSyncRepository("https://gitlab.com/owner/repo"), null);
  assert.equal(basaltSyncRepository("https://github.com/owner"), null);
  assert.equal(basaltSyncRepository(undefined), null);
  const link = new URL(bratInstallLink("owner/repo"));
  assert.equal(link.protocol, "obsidian:");
  assert.equal(link.host || link.pathname.replace(/^\/+/u, ""), "brat");
  assert.equal(link.searchParams.get("plugin"), "owner/repo");
  assert.equal(link.searchParams.get("version"), basaltSyncTag);
});

test("BRAT is linked only once the release holds every file Obsidian installs", () => {
  const assets = (...names: string[]) => ({ assets: names.map((name) => ({ name })) });
  assert.equal(
    basaltSyncReleaseStatus(200, assets("main.js", "manifest.json", "styles.css")),
    "available",
  );
  assert.equal(basaltSyncReleaseStatus(200, assets("main.js", "manifest.json")), "unavailable");
  assert.equal(basaltSyncReleaseStatus(200, {}), "unavailable");
  assert.equal(basaltSyncReleaseStatus(404, null), "unavailable");
  const limited = basaltSyncReleaseStatus(403, null);
  assert.equal(typeof limited === "object" && limited._tag, "BasaltSyncReleaseUnreachable");
});
