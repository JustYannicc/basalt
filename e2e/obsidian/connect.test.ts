import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { AppId, AppSlug, ToolName } from "@executor-js/sdk";
import { ConnectionId, ConnectionInput } from "@executor-js/mcp-auth/connections";
import {
  obsidianConnectionInput,
  obsidianConnectLink,
  obsidianTools,
  supportsObsidian,
} from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
import { githubSourceRepository } from "../../.upstream/apps/hosted/web/src/contracts/github-source.ts";
import {
  basaltSyncReleaseCheck,
  basaltSyncReleaseStatus,
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
  assert.equal(githubSourceRepository("https://github.com/owner/repo"), "owner/repo");
  assert.equal(githubSourceRepository("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(githubSourceRepository("https://gitlab.com/owner/repo"), null);
  assert.equal(githubSourceRepository("https://github.com/owner"), null);
  assert.equal(githubSourceRepository(undefined), null);
  const link = new URL(bratInstallLink("owner/repo"));
  assert.equal(link.protocol, "obsidian:");
  assert.equal(link.host || link.pathname.replace(/^\/+/u, ""), "brat");
  assert.equal(link.searchParams.get("plugin"), "owner/repo");
  assert.equal(link.searchParams.get("version"), basaltSyncTag);
});

test("BRAT is linked unless the release is known to be missing", () => {
  const assets = (...names: string[]) => ({ assets: names.map((name) => ({ name })) });
  assert.equal(
    basaltSyncReleaseStatus(200, assets("main.js", "manifest.json", "styles.css")),
    "available",
  );
  assert.equal(basaltSyncReleaseStatus(200, assets("main.js", "manifest.json")), "unavailable");
  assert.equal(basaltSyncReleaseStatus(200, {}), "unavailable");
  assert.equal(basaltSyncReleaseStatus(404, null), "unavailable");
  // GitHub's anonymous limit is 60 an hour per network address; running out must not hide the link.
  for (const status of [403, 429, 500, 503, null])
    assert.equal(basaltSyncReleaseStatus(status, null), "unconfirmed", String(status));
});

test("a found release is remembered for the session; a missing or unconfirmed one is asked again", async () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const replies: (number | "offline")[] = [404, 403, 429, "offline", 200];
  let fetches = 0;
  const original = {
    fetch: globalThis.fetch,
    storage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  };
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  globalThis.fetch = async () => {
    fetches++;
    const reply = replies.shift()!;
    if (reply === "offline") throw new TypeError("Failed to fetch");
    const body = {
      assets: [{ name: "main.js" }, { name: "manifest.json" }, { name: "styles.css" }],
    };
    return new Response(reply === 200 ? JSON.stringify(body) : "{}", { status: reply });
  };
  try {
    const check = () => Effect.runPromise(basaltSyncReleaseCheck("owner/repo"));
    // Not published yet: it may be published under this tag later, so this is not remembered.
    assert.equal(await check(), "unavailable");
    assert.equal(await check(), "unconfirmed");
    assert.equal(await check(), "unconfirmed");
    assert.equal(await check(), "unconfirmed");
    assert.equal(await check(), "available");
    assert.equal(fetches, 5, "each missing or unconfirmed answer is asked again");
    assert.equal(await check(), "available");
    assert.equal(fetches, 5, "a found release spends no more of the GitHub quota");
  } finally {
    globalThis.fetch = original.fetch;
    if (original.storage) Object.defineProperty(globalThis, "sessionStorage", original.storage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("the release check sends GitHub no credentials or dashboard headers", async () => {
  // GitHub answers with Access-Control-Allow-Origin "*", which browsers refuse for a credentialed
  // or non-simple request, so the check must look exactly like a plain anonymous fetch.
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    const body = {
      assets: [{ name: "main.js" }, { name: "manifest.json" }, { name: "styles.css" }],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    assert.equal(await Effect.runPromise(basaltSyncReleaseCheck("owner/repo")), "available");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://api.github.com/repos/owner/repo/releases/tags/${basaltSyncTag}`,
  );
  assert.equal(calls[0]!.init?.credentials, "omit");
  assert.deepEqual([...new Headers(calls[0]!.init?.headers).keys()], []);
});
