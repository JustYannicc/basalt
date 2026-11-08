import { test } from "node:test";
import assert from "node:assert/strict";
import { Schema } from "effect";
import { AppId, AppSlug, ToolName } from "@executor-js/sdk";
import { ConnectionId, ConnectionInput } from "@executor-js/mcp-auth/connections";
import {
  obsidianConnectionInput,
  obsidianConnectLink,
  obsidianTools,
  supportsObsidian,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import { parseConnectLink } from "../../clients/obsidian/link.ts";

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
