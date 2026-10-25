import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Effect, Layer, Context, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../../.upstream/e2e/support/managed-server.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";
import { proveInstalledClaude } from "./native-claude.mjs";
import { startZendeskFixtures } from "./zendesk-fixture.mjs";
import { startZendeskCatalogWorker, loadZendeskCatalogSource } from "./zendesk-catalog.mjs";
import { provisionSelfHostActors } from "./test-accounts.mjs";
import { proveZendeskNative } from "./zendesk.mjs";

const [root, upstream, directory, emulateBin, browserExecutable, upstreamPin, candidateSha, patchesJson] = process.argv.slice(2);
const carriedPatches = JSON.parse(patchesJson);
const require = createRequire(join(upstream, "package.json"));
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
const { chromium } = await import(pathToFileURL(require.resolve("playwright")).href);
process.chdir(upstream);
const emails = ["first@example.test", "second@example.test"];
const markers = ["synthetic_first_message", "synthetic_second_message"];
const scopes = ["openid", "email", "profile", "https://mail.google.com/", "https://www.googleapis.com/auth/gmail.settings.basic"];
let callback;
const check = (condition, operation) => assert.ok(condition, operation);
const step = (operation) => console.log(JSON.stringify({ stage: operation }));

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

async function emulator() {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const seed = join(directory, "google.json");
  await writeFile(seed, JSON.stringify({ google: {
    users: emails.map((email, i) => ({ email, name: `Synthetic user ${i + 1}` })),
    oauth_clients: [{ client_id: "connector-fixture-client", client_secret: "connector-fixture-secret", redirect_uris: [callback] }],
    messages: emails.map((email, i) => ({ id: markers[i], user_email: email, from: "sender@example.test", to: email,
      subject: `Synthetic message ${i + 1}`, body_text: "Connector proof", label_ids: ["INBOX"] })),
  } }), { mode: 0o600 });
  const child = spawn(process.execPath, [emulateBin, "--service", "google", "--port", String(port), "--base-url", origin, "--seed", seed], {
    cwd: directory, detached: true, env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let raw = ""; child.stdout.on("data", (data) => { raw += data; }); child.stderr.on("data", (data) => { raw += data; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); try { process.kill(-child.pid, "SIGTERM"); } catch {}
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
      await closed; clearTimeout(timer);
    }
    await writeFile(join(directory, "emulator.log"), raw, { mode: 0o600 });
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const ready = await fetch(`${origin}/.well-known/openid-configuration`).then((r) => r.ok, () => false);
      if (ready) return { origin, stop };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Published Google emulator did not start");
  } catch (error) { await stop(); throw error; }
}

function source(origin) {
  return `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const mail = defineProvider({ name: "Synthetic Google Gmail", hosts: [${JSON.stringify(new URL(origin).host)}], auth: {
  oauth: oauth2({ authorizationUrl: ${JSON.stringify(`${origin}/o/oauth2/v2/auth`)}, tokenUrl: ${JSON.stringify(`${origin}/oauth2/token`)}, scopes: ${JSON.stringify(scopes)} })
} });
export default defineApp({ user: { accounts: { mail } } }, {
  tools: router({ messages: query({ input: object({}), description: "List synthetic Gmail messages" }, async ({ user: { accounts } }) => {
    const response = await fetch(${JSON.stringify(`${origin}/gmail/v1/users/me/messages`)}, { headers: accounts.mail.headers() });
    if (!response.ok) throw new Error("Gmail responded " + response.status);
    return response.json();
  }) })
});`;
}

async function mcp(origin, token) {
  const client = new Client({ name: "connector-proof", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const text = (result) => JSON.stringify(result.structuredContent ?? result.content);

const program = Effect.gen(function* () {
  const receiver = yield* Effect.acquireRelease(Effect.promise(async () => {
    const server = createHttpServer((request, response) => {
      if (request.method !== "GET" || !request.url?.startsWith("/api/oauth/callback?")) {
        response.writeHead(404); response.end(); return;
      }
      response.setHeader("content-type", "text/plain"); response.end("Synthetic OAuth callback received");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); return server;
  }), (server) => Effect.promise(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }));
  callback = `http://127.0.0.1:${receiver.address().port}/api/oauth/callback`;
  const provider = yield* Effect.acquireRelease(Effect.promise(emulator), (server) => Effect.promise(server.stop));
  const browser = yield* Effect.acquireRelease(Effect.promise(() => chromium.launch({ headless: true, executablePath: browserExecutable })), (browser) => Effect.promise(() => browser.close()));
  step("published-emulator-ready");
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const marketplace = { name: "Signalbox", organizationId: "fixture-organization", appId: "fixture-app" };
  const marketplaceHeaders = {
    "X-Zendesk-Marketplace-Name": marketplace.name,
    "X-Zendesk-Marketplace-Organization-Id": marketplace.organizationId,
    "X-Zendesk-Marketplace-App-Id": marketplace.appId,
  };
  const zendeskFixtures = yield* Effect.acquireRelease(
    Effect.promise(() => startZendeskFixtures({ marketplaceHeaders })),
    (fixtures) => Effect.promise(() => fixtures.stop()),
  );
  const catalogWorker = yield* Effect.acquireRelease(
    Effect.promise(() => startZendeskCatalogWorker({ root, upstream, directory, marketplace })),
    (worker) => Effect.promise(() => worker.stop()),
  );
  const catalog = yield* Effect.promise(() => loadZendeskCatalogSource({
    root,
    catalogOrigin: catalogWorker.origin,
    directory,
    sites: zendeskFixtures.sites,
    marketplace,
    candidateSha,
    upstreamPin,
    carriedPatches,
  }));
  const definition = {
    id: "connector-fixture", label: "Synthetic hosted Google",
    server: { authorizationUrl: `${provider.origin}/o/oauth2/v2/auth`, tokenUrl: `${provider.origin}/oauth2/token`,
      authorizationParams: { access_type: "offline", prompt: "consent" } },
    tokenEndpointAuthMethod: "client_secret_post", defaultScopes: scopes, allowedScopes: scopes,
    placement: { hosts: [new URL(provider.origin).host] },
  };
  const prepared = yield* prepareScenario(base.target, "Connector OAuth and native MCP proof");
  const port = yield* Effect.promise(freePort);
  const authSecret = randomBytes(32).toString("hex");
  const preparedTarget = Target.of({ ...prepared, metadata: { ...prepared.metadata, origin: `http://127.0.0.1:${port}` } });
  const cliActors = yield* Effect.promise(() => provisionSelfHostActors({
    executable: process.execPath,
    upstream,
    target: preparedTarget,
    authSecret,
    directory,
  }));
  const allowedOrigins = [provider.origin, ...zendeskFixtures.sites.map(({ origin }) => origin)].sort();
  const server = yield* startManagedServer(preparedTarget, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_OAUTH_CALLBACK_URL: callback,
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([definition]),
    EXECUTOR_OAUTH_CONNECTOR_FIXTURE_CLIENT_ID: "connector-fixture-client",
    EXECUTOR_OAUTH_CONNECTOR_FIXTURE_CLIENT_SECRET: "connector-fixture-secret",
    EXECUTOR_ZENDESK_SUBDOMAIN: "example",
    EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: "zendesk-fixture-client",
    EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: "zendesk-fixture-secret",
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify(allowedOrigins),
  });
  const target = Target.of({ ...preparedTarget, controlOrigin: server.controlOrigin, metadata: { ...preparedTarget.metadata, origin: server.origin } });
  const services = yield* Layer.build(SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))));
  const sessionsApi = Context.get(services, SessionClients);
  const actors = {
    organization: cliActors.organization,
    owner: yield* sessionsApi.session(Redacted.make(cliActors.owner.cookies)),
    admin: yield* sessionsApi.session(Redacted.make(cliActors.admin.cookies)),
    member: yield* sessionsApi.session(Redacted.make(cliActors.member.cookies)),
  };
  const request = (actor, method, path, data) => sessionsApi.request(actor, method, path, data);
  const checked = (response, status, operation) => {
    if (response.status !== status) {
      const errorTag = typeof response.body?._tag === "string" ? response.body._tag : undefined;
      appendFileSync(join(directory, "responses.jsonl"), JSON.stringify({
        operation,
        status: response.status,
        ...(errorTag === undefined ? {} : { errorTag }),
      }) + "\n", { mode: 0o600 });
    }
    assert.equal(response.status, status, operation); return response.body;
  };
  const prefix = `/api/organizations/${actors.organization.id}`;
  const zendeskProof = yield* proveZendeskNative({
    Effect, request, checked, actors, directory, prefix, callback, candidateSha, upstreamPin, carriedPatches,
    target, root, upstream, fixtures: zendeskFixtures, catalog, step,
  });
  const app = checked(yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Synthetic Gmail connector proof", files: [{ path: "index.ts", content: source(provider.origin) }, appsManifest],
  }), 200, "Deploy synthetic Gmail app");
  const path = `${prefix}/apps/${app.id}`;
  const access = checked(yield* request(actors.owner, "GET", `${path}/access`), 200, "Read app audience");
  checked(yield* request(actors.owner, "PATCH", `${path}/access`, { revision: access.revision, audience: { kind: "everyone" } }), 200, "Share app within organization");
  step("real-runtime-and-shared-app-ready");
  const tokens = [];
  const sessions = [actors.member, actors.admin];
  const accounts = [];
  for (const [index, actor] of sessions.entries()) {
    const connection = checked(yield* request(actor, "POST", `${path}/accounts/user/mail/connections`, { destination: { kind: "personal" } }), 200, "Create personal OAuth connection");
    const started = checked(yield* request(actor, "POST", `${prefix}/connections/${connection.id}/oauth/start`, { method: "oauth", label: `Synthetic Google ${index + 1}` }), 200, "Start hosted OAuth without supplying client credentials");
    const url = new URL(started.authorizationUrl);
    assert.equal(started.redirectUri, callback, "Runtime uses the registered callback");
    assert.equal(url.searchParams.get("client_id"), "connector-fixture-client");
    assert.deepEqual(new Set((url.searchParams.get("scope") ?? "").split(" ")), new Set(scopes));
    const callbackUrl = yield* Effect.promise(async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.on("requestfailed", (request) => appendFileSync(join(directory, "browser-failures.jsonl"), JSON.stringify({ url: request.url(), failure: request.failure() }) + "\n", { mode: 0o600 }));
        // The receiver accepts the provider's real browser redirect; the runtime exchanges its code below.
        await page.goto(url.href);
        const choice = page.getByRole("button").filter({ hasText: emails[index] });
        await choice.waitFor({ state: "visible" });
        await page.screenshot({ path: join(directory, `oauth-user-picker-${index}.png`) });
        await Promise.all([page.waitForURL((value) => value.href.startsWith(callback)), choice.click()]);
        const redirected = new URL(page.url());
        check(redirected.searchParams.get("code"), "Browser received emulator authorization code");
        assert.equal(redirected.searchParams.get("state"), url.searchParams.get("state"));
        return redirected.href;
      } finally { await context.close(); }
    });
    const completed = checked(yield* request(actor, "POST", `${prefix}/connections/${connection.id}/oauth/complete`, { callbackUrl }), 200, "Exchange code and save private account through runtime");
    accounts.push(completed.id);
    const issued = checked(yield* request(actor, "POST", "/api/auth/api-key/create", { name: "Connector proof", metadata: { organization: actors.organization.id } }), 200, "Issue organization-pinned native PAT");
    tokens.push(issued.key);
  }
  step("two-native-oauth-accounts-completed");
  const clients = [];
  for (const token of tokens) clients.push(yield* Effect.acquireRelease(Effect.promise(() => mcp(target.metadata.origin, token)), (client) => Effect.promise(() => client.close())));
  const expression = `tools[${JSON.stringify(app.slug)}].messages`;
  let toolPath;
  for (const [index, client] of clients.entries()) {
    const own = markers[index], other = markers[1 - index], otherAccount = accounts[1 - index];
    const search = yield* Effect.promise(() => call(client, "search", { query: app.slug }));
    check(!search.isError && text(search).includes("messages"), "Native MCP finds shared app tool");
    const found = search.structuredContent?.items?.find((item) => item.path.endsWith(".messages"));
    check(found, "Native search returns the exact Gmail tool path");
    toolPath = found.path;
    check(!text(search).includes(otherAccount), "Native search excludes peer account");
    const describe = yield* Effect.promise(() => call(client, "describe", { paths: [toolPath] }));
    check(!describe.isError && !text(describe).includes(otherAccount), "Native describe excludes peer account");
    const result = yield* Effect.promise(() => call(client, "call", { calls: { path: toolPath, input: {} } }));
    check(!result.isError && text(result).includes(own) && !text(result).includes(other), "Native call reads only caller Gmail");
    const executed = yield* Effect.promise(() => call(client, "execute", { code: `return await ${expression}({});` }));
    check(!executed.isError && text(executed).includes(own) && !text(executed).includes(other), "Execute reads only caller Gmail");
    const forged = yield* Effect.promise(() => call(client, "call", { calls: { path: toolPath, input: { $accounts: { mail: otherAccount } } } }));
    check(text(forged).includes("AccountChoiceUnsupported"), "Call refuses peer account selection");
    const forgedExecution = yield* Effect.promise(() => call(client, "execute", { code: `return await ${expression}({ $accounts: { mail: ${JSON.stringify(otherAccount)} } });` }));
    check(text(forgedExecution).includes("AccountChoiceUnsupported"), "Execute refuses peer account selection");
    const inspect = yield* request(sessions[index], "GET", `${prefix}/accounts/${otherAccount}`);
    check(inspect.status === 403 || inspect.status === 404, "Peer account detail denied");
    const linked = yield* request(sessions[index], "PUT", `${path}/accounts/user/mail/${encodeURIComponent(otherAccount)}`);
    check(linked.status === 403 || linked.status === 404, "Linking peer account denied");
  }
  step("same-organization-native-mcp-isolation-passed");
  // Keep model and CLI processes outside the runtime's storage and credentials.
  yield* Effect.promise(() => proveInstalledClaude({ root, directory, origin: target.metadata.origin, token: tokens[0], slug: app.slug, toolPath, marker: markers[0] }));
  step("installed-claude-real-mcp-passed");
  return {
    ...zendeskProof,
    checks: 23 + zendeskProof.checks,
    sameOrganizationUsers: true,
    sharedHostedApp: true,
    privateAccountLinks: true,
    runtimeMcpCall: true,
    publishedGoogleEmulatorOAuth: true,
    testAccountsProvisionedByPinnedCli: true,
    zendeskNativeAuthorizationStart: true,
    zendeskPeerConnectionDenials: 2,
    zendeskProviderConsentCompleted: false,
    installedClaude: true,
    BasaltPoolAppAccess: false,
    productionOfficialGmailEndToEnd: false,
  };
});

await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
try {
  const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Connector runtime proof failed; private diagnostics retained."); process.exitCode = 1;
}
