import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnectLink, parseConnectLink, protocolAction } from "./link.ts";

const connection = "https://basalt.example/mcp?connection=conn_123";

test("a link built in Basalt opens as the same scoped connection in Obsidian", () => {
  const link = buildConnectLink({
    connection,
    appId: "app_1",
    appSlug: "notes",
    vaultName: "My Vault",
  });
  const url = new URL(link);
  assert.equal(url.protocol, "obsidian:");
  assert.equal(url.host || url.pathname.replace(/^\/+/u, ""), protocolAction);
  assert.doesNotMatch(link, /\+/u);
  const params = Object.fromEntries(new URLSearchParams(url.search));
  const request = parseConnectLink({ action: protocolAction, ...params });
  assert.deepEqual(request.config, {
    connection: "https://basalt.example/mcp?connection=conn_123&elicitation_mode=native",
    appId: "app_1",
    appSlug: "notes",
  });
  assert.equal(request.vaultName, "My Vault");
  assert.equal(request.host, "basalt.example");
});

test("links that would widen access or downgrade transport are refused", () => {
  const base = { action: protocolAction, appId: "app_1", appSlug: "notes" };
  assert.throws(
    () => parseConnectLink({ ...base, connection: "http://basalt.example/mcp?connection=c" }),
    /HTTPS/u,
  );
  assert.throws(
    () => parseConnectLink({ ...base, connection: "https://basalt.example/mcp" }),
    /app-scoped/u,
  );
  assert.throws(
    () => parseConnectLink({ ...base, connection: "https://basalt.example/api?connection=c" }),
    /app-scoped/u,
  );
  assert.throws(() => parseConnectLink({ ...base, connection, appId: "../x" }), /invalid app/u);
  assert.throws(() => parseConnectLink({ action: protocolAction, connection }), /incomplete/u);
});
