import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openEnvelope } from "../pool/token.ts";
import { handleSetup, type SetupEnv } from "./host.ts";

const origin = "https://setup.example";
const secret = "ab".repeat(32);
const computer = { id: "computer-1", name: "Laptop", poolId: "pool-1", state: "issuing", createdAt: "2026-01-01T00:00:00Z", firstModelRequestAt: null, firstToolCallAt: null, revokedAt: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
type Call = { path: string; request: Request; input: Record<string, unknown> };
type Override = (call: Call) => Response | undefined | Promise<Response | undefined>;
function fixture(options: { tools?: Override; pool?: Override; onProductEvent?: SetupEnv["onProductEvent"] } = {}) {
  const calls: Call[] = [];
  let claimed = false;
  const env: SetupEnv = {
    POOL_APP_SIGNING_KEY: secret,
    TOOLS_SERVICE: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const input = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
      const call = { path, request, input };
      calls.push(call);
      const response = await options.tools?.(call);
      if (response) return response;
      if (path === "/api/auth/get-session") return json({ user: { id: "user-1", emailVerified: true } });
      if (path === "/api/auth/api-key/create") return json({ id: "tools-key-1", key: "exp_fake-tools-secret" });
      if (path === "/api/auth/organization/list") return json([{ id: "organization-1", metadata: JSON.stringify({ basaltPools: { "user-1": { app: "pool-1" } } }) }]);
      if (/^\/api\/organizations\/[^/]+\/apps\/[^/]+\/access$/.test(path)) return json({ creator: "user-1", audience: { kind: "private" } });
      if (path === "/api/auth/api-key/delete") return json({ success: true });
      throw Error(`Unexpected native path: ${path}`);
    } },
    POOL_SERVICE: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const wire = await request.json() as { envelope: string };
      assert.deepEqual(Object.keys(wire), ["envelope"]);
      const input = await openEnvelope(secret, "sbs1", wire.envelope) as Record<string, unknown>;
      assert.equal(input.action, path.split("/").at(-1));
      assert.equal(typeof input.expiresAt, "number");
      assert.ok(Number(input.expiresAt) > Date.now() && Number(input.expiresAt) <= Date.now() + 30_000);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("authorization"), null);
      const call = { path, request, input };
      calls.push(call);
      const response = await options.pool?.(call);
      if (response) return response;
      if (path.endsWith("/validate")) return json({ pool: "pool-1", organization: "organization-1", owner: "user-1" });
      if (path.endsWith("/links") || path.endsWith("/refresh")) return json({ computer, token: "opaque-link-token", expiresAt: new Date(Date.now() + 299_000).toISOString() });
      if (path.endsWith("/computers")) return json({ computers: [computer] });
      if (path.endsWith("/revoke")) return json({ toolsKeyId: "tools-key-1" });
      if (path.endsWith("/revoked")) return json({ success: true });
      if (path.endsWith("/claim")) {
        if (claimed) return json({ error: "raw internal failure exp_fake-tools-secret" }, 410);
        claimed = true;
        return input.format === "json" ? json({ version: 1, credentials: { toolsToken: "exp_fake-tools-secret" }, instructions: "Install" })
          : new Response("Install with exp_fake-tools-secret");
      }
      throw Error(`Unexpected pool path: ${path}`);
    } },
    onProductEvent: options.onProductEvent,
  };
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ cookie: "executor-hosted.session_token=fake-cookie", origin });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return handleSetup(new Request(`${origin}${path}`, { ...init, headers }), env);
  };
  const create = (input: unknown = { intent: "signed-selection", name: "Laptop" }, headers = {}) => request("/setup/v1/links", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
  });
  return { env, calls, request, create };
}

function secured(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

test("native browser identity and signed pool intent precede token mint; the paste has no credentials", async () => {
  const f = fixture();
  const response = await f.create();
  assert.equal(response.status, 200);
  secured(response);
  const wire = await response.text();
  assert.ok(!wire.includes("exp_fake-tools-secret"));
  assert.ok(!wire.includes("tools-key-1"));
  const result = JSON.parse(wire);
  assert.equal(result.computerId, computer.id);
  assert.deepEqual(result.computer, computer);
  assert.match(result.prompt, /https:\/\/setup.example\/setup\/claim\/opaque-link-token/);
  assert.match(result.command, /node --input-type=module/);
  assert.match(result.command, /mkdtemp/);
  assert.match(result.command, /mode:0o600/);
  assert.match(result.command, /finally/);
  assert.match(result.command, /\/setup\/client.mjs/);
  assert.match(result.command, /'--link' 'https:\/\/setup.example\/setup\/claim\/opaque-link-token'/);
  assert.match(result.powershellCommand, /SetAccessRuleProtection\(\$true,\$false\)/);
  // Patched Windows PowerShell 5.1 otherwise pauses for a script-execution confirmation.
  assert.match(result.powershellCommand, /Invoke-WebRequest -UseBasicParsing -Uri/);
  assert.match(result.powershellCommand, /finally \{ Remove-Item/);
  assert.match(result.undoPrompt, /--undo/);
  // The intent names the person's own pool, so no organization lookup is needed.
  assert.deepEqual(f.calls.map((c) => c.path), ["/api/auth/get-session", "/__setup/v1/validate", "/api/auth/api-key/create", "/__setup/v1/links"]);
  const sessionUrl = new URL(f.calls[0]!.request.url);
  assert.equal(sessionUrl.searchParams.get("disableCookieCache"), "true");
  assert.equal(sessionUrl.searchParams.get("disableRefresh"), "true");
  const create = f.calls[2]!;
  assert.equal(new URL(create.request.url).origin, origin);
  assert.equal(create.request.headers.get("origin"), origin);
  assert.equal(create.request.headers.get("cookie"), "executor-hosted.session_token=fake-cookie");
  assert.deepEqual(create.input, { name: "Laptop", metadata: { organization: "organization-1" } });
  assert.equal(f.calls[3]!.input.user, "user-1");
  assert.equal(f.calls[3]!.input.intent, "signed-selection");
  assert.equal(f.calls[3]!.input.toolsToken, "exp_fake-tools-secret");
  // The person's own pool travels only inside the signed assertion.
  assert.deepEqual(f.calls[3]!.input.own, { pool: "pool-1", organization: "organization-1" });
});

test("setup started is emitted only after a new durable setup link succeeds", async () => {
  const events: [string, string][] = [];
  const f = fixture({ onProductEvent: (event, accountId) => events.push([event, accountId]) });
  assert.equal((await f.create()).status, 200);
  assert.deepEqual(events, [["setup_started", "user-1"]]);

  assert.equal((await f.create({ intent: "signed-selection", computerId: "computer-1" })).status, 200);
  assert.deepEqual(events, [["setup_started", "user-1"]]);

  const failedEvents: [string, string][] = [];
  const failed = fixture({
    onProductEvent: (event, accountId) => failedEvents.push([event, accountId]),
    pool: ({ path }) => path.endsWith("/links") ? json({ error: "unavailable" }, 503) : undefined,
  });
  assert.equal((await failed.create()).status, 502);
  assert.deepEqual(failedEvents, []);
});

test("a computer on a shared pool gets a tools token pinned to the person's own organization", async () => {
  const shared = { pool: ({ path }: Call) => path.endsWith("/validate") ? json({ pool: "shared-pool", organization: "shared-organization", owner: "another-person" }) : undefined };
  const f = fixture({
    ...shared,
    tools: ({ path }) => path === "/api/auth/organization/list" ? json([
      { id: "shared-organization", metadata: JSON.stringify({ basaltPools: { "another-person": { app: "shared-pool" } } }) },
      { id: "own-organization", metadata: JSON.stringify({ basaltPools: { "user-1": { app: "own-pool" } } }) },
    ]) : undefined,
  });
  const response = await f.create();
  assert.equal(response.status, 200);
  const create = f.calls.find((call) => call.path === "/api/auth/api-key/create")!;
  assert.deepEqual(create.input, { name: "Laptop", metadata: { organization: "own-organization" } });
  assert.equal(f.calls.find((call) => call.path === "/__setup/v1/links")!.input.intent, "signed-selection");

  // Without an own pool there is no own organization to pin tools to, so nothing is minted.
  const orphan = fixture({ ...shared, tools: ({ path }) => path === "/api/auth/organization/list"
    ? json([{ id: "shared-organization", metadata: { basaltPools: { "another-person": {} } } }]) : undefined });
  const refused = await orphan.create();
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /own pool is still being set up/);
  assert.equal(orphan.calls.some((call) => call.path.endsWith("/api-key/create")), false);
});

test("a pool named in organization metadata counts as the person's own only if they created it", async () => {
  const shared = ({ path }: Call) => path.endsWith("/validate") ? json({ pool: "shared-pool", organization: "shared-organization", owner: "another-person" }) : undefined;
  const forged = fixture({ pool: shared, tools: ({ path }) => path === "/api/auth/organization/list"
    ? json([{ id: "attacker-organization", metadata: { basaltPools: { "user-1": { app: "victim-pool" } } } }])
    : path.endsWith("/apps/victim-pool/access") ? json({ creator: "victim", audience: { kind: "private" } }) : undefined });
  const refused = await forged.create();
  assert.equal(refused.status, 409);
  assert.equal(forged.calls.some((call) => call.path.endsWith("/api-key/create") || call.path.endsWith("/links")), false);
  const listing = await forged.request("/setup/v1/computers?intent=signed-selection");
  assert.equal(listing.status, 200);
  assert.equal(forged.calls.find((call) => call.path.endsWith("/computers"))!.input.own, undefined);
});

test("switching a computer's pool is one signed request that re-points its key; nothing is minted", async () => {
  const moved = { ...computer, state: "active", poolId: "shared-pool" };
  const f = fixture({ pool: ({ path }) => path.endsWith("/switch") ? json({ ...moved, keyId: 7, toolsHash: "x" }) : undefined });
  const response = await f.request("/setup/v1/computers/computer-1/pool", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "signed-selection", pool: "shared-pool" }),
  });
  assert.equal(response.status, 200);
  secured(response);
  assert.deepEqual((await response.json()).computer, moved);
  assert.deepEqual(f.calls.map((c) => c.path), ["/api/auth/get-session", "/api/auth/organization/list", "/api/organizations/organization-1/apps/pool-1/access", "/__setup/v1/switch"]);
  assert.deepEqual({ ...f.calls[3]!.input, expiresAt: 0 }, {
    user: "user-1", intent: "signed-selection", id: "computer-1", pool: "shared-pool",
    own: { pool: "pool-1", organization: "organization-1" }, action: "switch", expiresAt: 0,
  });
  for (const body of [{ intent: "signed-selection" }, { intent: "signed-selection", pool: "p", name: "x" }, { pool: "p" }]) {
    const bad = fixture();
    const result = await bad.request("/setup/v1/computers/computer-1/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(result.status, 400);
    assert.equal(bad.calls.length, 0);
  }
  const refused = fixture({ pool: ({ path }) => path.endsWith("/switch") ? json({ error: "not_found", message: "You can't use that pool anymore." }, 403) : undefined });
  const denied = await refused.request("/setup/v1/computers/computer-1/pool", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "signed-selection", pool: "gone" }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "You can't use that pool anymore.");
  const crossSite = fixture();
  assert.equal((await crossSite.request("/setup/v1/computers/computer-1/pool", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" }, body: JSON.stringify({ intent: "i", pool: "p" }),
  })).status, 403);
  assert.equal(crossSite.calls.length, 0);
});

test("listing works while the organization list is down; minting on a shared pool waits for it", async () => {
  const down = ({ path }: Call) => path === "/api/auth/organization/list" ? new Response("unavailable", { status: 503 }) : undefined;
  const shared = ({ path }: Call) => path.endsWith("/validate") ? json({ pool: "shared-pool", organization: "shared-organization", owner: "another-person" }) : undefined;
  const listing = fixture({ tools: down, pool: shared });
  assert.equal((await listing.request("/setup/v1/computers?intent=signed-selection")).status, 200);
  assert.equal(listing.calls.find((call) => call.path.endsWith("/computers"))!.input.own, undefined);
  const minting = fixture({ tools: down, pool: ({ path }) => path.endsWith("/validate") ? json({ pool: "shared-pool", organization: "shared-organization", owner: "another-person" }) : undefined });
  assert.equal((await minting.create()).status, 502);
  assert.equal(minting.calls.some((call) => call.path.endsWith("/api-key/create")), false);
});

test("the computer list carries only pool ids, names and ownership", async () => {
  const f = fixture({ pool: ({ path }) => path.endsWith("/computers") ? json({
    computers: [computer], pools: [{ id: "own-pool", name: "My pool", mine: true, owner: "user-1" }, { id: "shared-pool", name: "Ada's pool", mine: false, organization: "o" }],
  }) : undefined });
  const response = await f.request("/setup/v1/computers?intent=signed-selection");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pools, [{ id: "own-pool", name: "My pool", mine: true }, { id: "shared-pool", name: "Ada's pool", mine: false }]);
  const broken = fixture({ pool: ({ path }) => path.endsWith("/computers") ? json({ computers: [], pools: [{ id: "p" }] }) : undefined });
  assert.equal((await broken.request("/setup/v1/computers?intent=signed-selection")).status, 502);
});

test("write origins must match exactly; every Authorization header is refused", async () => {
  for (const badOrigin of ["", "null", "https://other.example", `${origin}/`, `${origin}:443`]) {
    const f = fixture();
    assert.equal((await f.create(undefined, { Origin: badOrigin })).status, 403);
    assert.equal(f.calls.length, 0);
  }
  for (const path of ["/setup/v1/computers?intent=x", "/setup/claim/opaque-link-token"]) {
    for (const authorization of ["", "Bearer fake"]) {
      const f = fixture();
      assert.equal((await f.request(path, { headers: { authorization } })).status, 403);
      assert.equal(f.calls.length, 0);
    }
  }
});

test("missing, unverified, malformed and unavailable sessions fail before the pool", async () => {
  for (const [value, expected] of [[null, 401], [{ user: { id: "u", verified: true } }, 403], [{ user: { id: "u", emailVerified: false } }, 403], [{ user: {} }, 401]] as const) {
    const f = fixture({ tools: () => json(value) });
    assert.equal((await f.create()).status, expected);
    assert.equal(f.calls.length, 1);
  }
  const missing = fixture();
  assert.equal((await missing.create(undefined, { Cookie: "" })).status, 401);
  assert.equal(missing.calls.length, 0);
  const failure = fixture({ tools: () => { throw Error("exp_secret from native"); } });
  const response = await failure.create();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("exp_secret"));
});

test("invalid input, oversized input, unknown routes and unsupported methods cause no service calls", async () => {
  for (const input of [{ name: "Laptop" }, { intent: "x", name: " " }, { intent: "x", name: "a".repeat(61) }, { intent: "x", name: "a\nb" }, { intent: "x", name: "Laptop", user: "forged" }, { intent: "x", name: "Laptop", computerId: "computer-1" }]) {
    const f = fixture();
    assert.equal((await f.create(input)).status, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.create({ intent: "x".repeat(17_000), name: "Laptop" })).status, 413);
  assert.equal((await f.request("/setup/v1/links", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await f.request("/setup/v1/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  for (const [path, method, status] of [["/__setup/v1/links", "POST", 404], ["/setup/v1/computers", "POST", 405], ["/setup/claim/opaque", "HEAD", 405], ["/setup/claim/opaque", "OPTIONS", 405], ["/setup/claim/opaque", "POST", 405], ["/setup/claim/a%2Fb", "GET", 404]] as const) {
    const response = await f.request(path, { method });
    assert.equal(response.status, status);
    secured(response);
  }
  assert.equal(f.calls.length, 0);
});

test("invalid pool selection prevents key creation; native failures never reach browser verbatim", async () => {
  const denied = fixture({ pool: () => json({ error: "private" }, 403) });
  assert.equal((await denied.create()).status, 403);
  assert.ok(!denied.calls.some((c) => c.path.endsWith("/create")));
  const f = fixture({ tools: ({ path }) => path.endsWith("/create") ? new Response("exp_secret", { status: 500 }) : undefined });
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("exp_secret"));
});

test("a failed handoff rolls back its newly created tools token", async () => {
  const f = fixture({ pool: ({ path }) => path.endsWith("/links") ? json({ error: "exp_secret" }, 503) : undefined });
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.deepEqual(f.calls.at(-1)!.input, { keyId: "tools-key-1" });
  assert.equal(f.calls.at(-1)!.path, "/api/auth/api-key/delete");
  assert.ok(!(await response.text()).includes("exp_secret"));
});

test("browser metadata excludes credentials; links over five minutes are refused and cleaned up", async () => {
  const f = fixture({ pool: ({ path }) => path.endsWith("/computers") ? json({ computers: [{ ...computer, toolsToken: "exp_secret", modelKey: "model-secret" }] }) : undefined });
  const response = await f.request("/setup/v1/computers?intent=signed-selection");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.computers, [computer]);
  assert.match(result.undoPrompt, /--undo/);
  const long = fixture({ pool: ({ path }) => path.endsWith("/links") ? json({ computer, token: "opaque", expiresAt: new Date(Date.now() + 600_000).toISOString() }) : undefined });
  assert.equal((await long.create()).status, 502);
  assert.equal(long.calls.at(-1)!.path, "/api/auth/api-key/delete");
});

test("claims need no session, negotiate JSON or markdown and consume exactly once", async () => {
  for (const format of ["json", "markdown"]) {
    const f = fixture();
    const response = await f.request(`/setup/claim/opaque-link-token?format=${format}`, { headers: { Cookie: "" } });
    assert.equal(response.status, 200);
    secured(response);
    assert.match(response.headers.get("content-type")!, format === "json" ? /application\/json/ : /text\/markdown/);
    assert.match(await response.text(), /exp_fake-tools-secret/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.input.format, format);
    const replay = await f.request("/setup/claim/opaque-link-token");
    assert.equal(replay.status, 410);
    assert.ok(!(await replay.text()).includes("exp_fake-tools-secret"));
  }
  const f = fixture();
  assert.equal((await f.request("/setup/claim/opaque?format=html")).status, 400);
  assert.equal(f.calls.length, 0);
  await f.request("/setup/claim/opaque", { headers: { Accept: "application/json" } });
  assert.equal(f.calls[0]!.input.format, "json");
});

test("paired revocation runs model revoke, native tools delete, then finalization", async () => {
  const f = fixture();
  const response = await f.request("/setup/v1/computers/computer-1?intent=signed-selection", { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.map((c) => c.path), ["/api/auth/get-session", "/__setup/v1/validate", "/__setup/v1/revoke", "/api/auth/api-key/delete", "/__setup/v1/revoked"]);
  assert.equal(f.calls[2]!.input.id, "computer-1");
  assert.deepEqual(f.calls[3]!.input, { keyId: "tools-key-1" });
});

test("failed tools revoke never finalizes; retry accepts native KEY_NOT_FOUND only", async () => {
  let retry = false;
  const f = fixture({ tools: ({ path }) => path.endsWith("/delete") ? json(retry ? { code: "KEY_NOT_FOUND" } : { error: "exp_secret" }, retry ? 404 : 500) : undefined });
  const remove = () => f.request("/setup/v1/computers/computer-1?intent=x", { method: "DELETE" });
  assert.equal((await remove()).status, 502);
  assert.ok(!f.calls.some((c) => c.path.endsWith("/revoked")));
  retry = true;
  assert.equal((await remove()).status, 200);
  assert.equal(f.calls.at(-1)!.path, "/__setup/v1/revoked");
  const unknown = fixture({ tools: ({ path }) => path.endsWith("/delete") ? json({ code: "NOT_FOUND" }, 404) : undefined });
  assert.equal((await unknown.request("/setup/v1/computers/computer-1?intent=x", { method: "DELETE" })).status, 502);
  assert.ok(!unknown.calls.some((c) => c.path.endsWith("/revoked")));
});

test("refresh rotates only the unclaimed link and never mints another personal token", async () => {
  const f = fixture();
  assert.equal((await f.create({ intent: "x", computerId: "computer-1" })).status, 200);
  assert.deepEqual(f.calls.map((c) => c.path), ["/api/auth/get-session", "/__setup/v1/validate", "/__setup/v1/refresh"]);
  assert.equal(f.calls[2]!.input.id, "computer-1");
  const conflict = fixture({ pool: ({ path }) => path.endsWith("/refresh") ? json({ error: "private" }, 409) : undefined });
  const response = await conflict.create({ intent: "x", computerId: "computer-1" });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Revoke this computer/);
});

test("shell fallback executes the downloaded installer with --link and cleans up its private files", async () => {
  const f = fixture();
  const result = await (await f.create()).json();
  const temp = await mkdtemp(join(tmpdir(), "setup-command-test-"));
  try {
    const preload = join(temp, "fetch.mjs");
    const installer = `import{statSync}from'node:fs';import{dirname}from'node:path';console.log(JSON.stringify({args:process.argv.slice(2),file:process.argv[1],dir:dirname(process.argv[1]),mode:statSync(process.argv[1]).mode&0o777,dirMode:statSync(dirname(process.argv[1])).mode&0o777}));`;
    await writeFile(preload, `globalThis.fetch=async(url)=>{if(url!==${JSON.stringify(`${origin}/setup/client.mjs`)})throw Error('Unexpected download');return new Response(${JSON.stringify(installer)})};`);
    const output = execFileSync("/bin/sh", ["-c", result.command], {
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, encoding: "utf8",
    });
    const ran = JSON.parse(output);
    assert.deepEqual(ran.args, ["--link", `${origin}/setup/claim/opaque-link-token`]);
    assert.equal(ran.mode, 0o600);
    assert.equal(ran.dirMode, 0o700);
    assert.equal(existsSync(ran.file), false);
    assert.equal(existsSync(ran.dir), false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
