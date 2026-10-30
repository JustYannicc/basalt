import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { PoolControl } from "../../src/pool/attribution.ts";
import { HomeClient, PoolHome, poolGroupPrefix } from "../../src/pool/control.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { importAccounts, type ImportConfig } from "../cutover/import.ts";
import { SyntheticOAuthProvider } from "./import-fixture.ts";
import { migrateCodexWebSockets } from "../../src/pool/codex-websockets.ts";
import { MemoryStorage, SharingFixture } from "./sharing-fixture.ts";

const signingKey = "ab".repeat(32);
const owner = "fixture-import-owner";
const pool = "fixture-cutover-pool";
const otherPool = "fixture-neighbor-pool";
const expires = "2099-01-01T00:00:00.000Z";

class ControllerStorage extends MemoryStorage {
  async getAlarm(): Promise<number | null> { return null; }
  async setAlarm(_time: number): Promise<void> {}
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.synthetic-signature`;
}

test("cutover importer assigns synthetic Claude and Codex logins and verifies real pinned node usage", { timeout: 420_000 }, async () => {
  const provider = new SyntheticOAuthProvider();
  let fixture: SharingFixture | undefined;
  const bridgeEvents: string[] = [];
  const bridgeStages: string[] = [];
  const bridgeFailures: string[] = [];
  const importedIds: string[] = [];
  const postUploadCatalogs: { status: number; ids: string[] }[] = [];
  const postUploadCredentialStates: { provider: string; status: string | null; disabled: boolean; unavailable: boolean }[] = [];
  const postUploadAssignments: { provider: string; target: boolean; neighbor: boolean }[] = [];
  const stages: string[] = [];
  let stage = "synthetic provider start";
  const mark = (value: string) => {
    stage = value;
    stages.push(value);
    console.log(`Import fixture stage: ${value}`);
  };
  try {
    mark(stage);
    await provider.start();
    mark("synthetic provider ready");
    fixture = new SharingFixture({
      resourcePrefix: "basalt-1420-import",
      poolContainerArgs: provider.poolContainerArgs,
      operationTimeoutMs: 20_000,
      readinessTimeoutMs: 30_000,
      onStage: mark,
    });
    stage = "pinned Home/node Docker start";
    mark(stage);
    await fixture.start();
    mark("pinned Home/node Docker fixture ready");

    stage = "pool membership and API key setup";
    mark(stage);
    const homeClient = new HomeClient((input, init) => fixture!.fetchHome(input, init));
    const computerHome = new ComputerHome(homeClient);
    await computerHome.group(otherPool);
    const api = await computerHome.mint(owner, pool, "synthetic-import-proof");
    const poolToken = await signPoolToken(signingKey, { pool, owner, organization: "fixture-org" });
    const control = new PoolControl(new ControllerStorage(), {
      signingKey,
      home: (path, init) => fixture!.fetchHome(path, init),
    });

    const codexToken = jwt({
      exp: Math.floor(Date.parse(expires) / 1000), email: "synthetic-codex@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "synthetic-codex-account", chatgpt_user_id: "synthetic-codex-user", chatgpt_plan_type: "plus",
      },
    });
    const diagnosticRedactions = [
      api.key, poolToken, codexToken, signingKey,
      "sk-ant-oat01-synthetic-claude", "synthetic-claude-refresh", "synthetic-codex-refresh",
    ];
    fixture.addLogRedactions(diagnosticRedactions);
    const diagnosticFailure = (error: unknown): string => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
      return diagnosticRedactions.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message).slice(0, 500);
    };
    const config: ImportConfig = {
      origin: "https://pool.example.test", poolToken, owner, apiKey: api.key,
      accounts: [
        { file: {
          type: "claude", email: "synthetic-claude@example.invalid", access_token: "sk-ant-oat01-synthetic-claude",
          refresh_token: "synthetic-claude-refresh", expired: expires, proxy_url: provider.url,
        }, model: "claude-sonnet-4-5-20250929" },
        { file: {
          type: "codex", email: "synthetic-codex@example.invalid", access_token: codexToken, id_token: codexToken,
          refresh_token: "synthetic-codex-refresh", expired: expires, expires_at: expires,
          account_id: "synthetic-codex-account", proxy_url: provider.url,
        }, model: "gpt-5.6-luna" },
      ],
    };

    const bridge: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/pool/v1/")) {
        bridgeStages.push(`${request.method} ${url.pathname} started`);
        const response = await control.handle(request);
        bridgeEvents.push(`${request.method} ${url.pathname} ${response.status}`);
        if (url.pathname === "/pool/v1/login-files" && response.ok) {
          const value = await response.clone().json() as { accountId?: string };
          const accountIndex = importedIds.length;
          const account = config.accounts[accountIndex];
          assert.ok(account);
          const provider = account.file.type;
          assert.ok(provider === "claude" || provider === "codex", "Synthetic login provider must be claude or codex");
          assert.equal(typeof value.accountId, "string");
          importedIds.push(value.accountId!);
          const imported = value.accountId!;
          const files = await fixture!.data<{ files?: {
            id?: unknown; provider?: unknown; type?: unknown; status?: unknown; disabled?: unknown; unavailable?: unknown;
          }[] }>("/credentials");
          const credential = files.files?.find((file) => file.id === imported);
          postUploadCredentialStates.push({
            provider,
            status: typeof credential?.status === "string" ? credential.status : null,
            disabled: credential?.disabled === true,
            unavailable: credential?.unavailable === true,
          });
          const membership = await homeClient.allMembership();
          const target = membership.groups.find((group) => group.channel_name === `${poolGroupPrefix}${pool}`);
          const neighbor = membership.groups.find((group) => group.channel_name === `${poolGroupPrefix}${otherPool}`);
          const assignedGroups = membership.members.filter((member) => member.auth_id === imported).map((member) => member.channel_group_id);
          postUploadAssignments.push({
            provider,
            target: !!target && assignedGroups.includes(target.id),
            neighbor: !!neighbor && assignedGroups.includes(neighbor.id),
          });
          const catalog = await fetch(`${fixture!.node}/v1/models`, {
            headers: { Authorization: `Bearer ${api.key}` }, signal: AbortSignal.timeout(10_000),
          });
          const payload = await catalog.json().catch(() => ({})) as { data?: { id?: unknown }[] };
          const ids = Array.isArray(payload.data) ? payload.data.flatMap((model) => typeof model.id === "string" ? [model.id] : []) : [];
          postUploadCatalogs.push({
            status: catalog.status,
            ids,
          });
          if (!ids.includes(account.model)) {
            const failure = `Pinned node catalog omitted configured ${account.file.type} model ${account.model}`;
            bridgeFailures.push(failure);
            assert.fail(failure);
          }
        }
        return response;
      }
      if (url.pathname === "/v1/chat/completions") {
        bridgeStages.push(`${request.method} ${url.pathname} started`);
        const target = new URL(url.pathname + url.search, fixture!.node);
        const response = await fetch(target, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer()),
          signal: request.signal,
        });
        let event = `${request.method} ${url.pathname} ${response.status}`;
        if (!response.ok) {
          let body = await response.clone().text();
          for (const secret of [api.key, poolToken, "sk-ant-oat01-synthetic-claude", "synthetic-claude-refresh", "synthetic-codex-refresh", codexToken]) {
            body = body.replaceAll(secret, "[redacted]");
          }
          event += ` ${body.slice(0, 500)}`;
        }
        bridgeEvents.push(event);
        return response;
      }
      throw new Error(`Unexpected importer request: ${request.method} ${url.pathname}`);
    };

    stage = "importAccounts and real control/node bridge";
    mark(stage);
    assert.deepEqual(await importAccounts(config, { fetch: bridge }), { verified: 2 });
    assert.equal(importedIds.length, 2);
    assert.equal(new Set(importedIds).size, 2);
    for (const id of importedIds) assert.match(id, /^[0-9a-f-]{36}$/i);
    const credentialFiles = (await homeClient.data("/credentials")).files as Record<string, unknown>[];
    const codexFiles = credentialFiles.filter((file) => importedIds.includes(String(file.id)) && file.provider === "codex");
    assert.equal(codexFiles.length, 1);
    assert.equal(codexFiles[0]!.websockets, true, "Codex imports must enable and read back the pinned Home transport flag");
    // Simulate an existing credential and prove the same supported field API migrates it.
    const transportPatch = await homeClient.data("/credentials/fields", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: codexFiles[0]!.id, websockets: false }),
    });
    assert.equal(transportPatch.status, "ok");
    const plan = await migrateCodexWebSockets(homeClient);
    assert.equal(plan.pending, 1);
    assert.equal(plan.applied, 0);
    const applied = await migrateCodexWebSockets(homeClient, plan);
    assert.equal(applied.status, "complete");
    assert.equal(applied.applied, 1);

    const membership = await homeClient.allMembership();
    const target = membership.groups.find((group) => group.channel_name === `${poolGroupPrefix}${pool}`);
    const neighbor = membership.groups.find((group) => group.channel_name === `${poolGroupPrefix}${otherPool}`);
    assert.ok(target);
    assert.ok(neighbor);
    const importedMembership = membership.members.filter((member) => importedIds.includes(member.auth_id));
    assert.deepEqual(new Set(importedMembership.map((member) => member.auth_id)), new Set(importedIds));
    assert.deepEqual(new Set(importedMembership.map((member) => member.channel_group_id)), new Set([target.id]));
    assert.ok(importedMembership.every((member) => member.channel_group_id !== neighbor.id));

    const view = await new PoolHome(homeClient, pool).view(true);
    assert.deepEqual(view.accounts.map((account) => account.provider).sort(), ["claude", "codex"]);
    const providerPathname = (path: string) => new URL(path, "https://synthetic.invalid").pathname;
    assert.ok(provider.requests.some((request) => request.authority === "api.anthropic.com"
      && request.method === "POST" && providerPathname(request.path) === "/v1/messages"));
    assert.ok(provider.requests.some((request) => request.authority === "chatgpt.com"
      && request.method === "POST" && providerPathname(request.path).endsWith("/responses")));
    assert.deepEqual(bridgeEvents.filter((event) => event.startsWith("POST ")), [
      "POST /pool/v1/login-files 200", "POST /v1/chat/completions 200",
      "POST /pool/v1/login-files 200", "POST /v1/chat/completions 200",
    ]);
    console.log("PASS: real Home imported both synthetic OAuth files, pool membership is isolated, and the pinned node produced exact-account usage through the local provider fixture");
  } catch (error) {
    console.error("Import proof diagnostics:", JSON.stringify({
      stage,
      stages,
      bridgeStages,
      bridgeEvents,
      bridgeFailures,
      postUploadCatalogs,
      postUploadCredentialStates,
      postUploadAssignments,
      providerRequests: provider.requests.map(({ authority, method, path }) => ({ authority, method, path })),
    }));
    if (fixture) console.error("Pinned pool logs:", JSON.stringify(await fixture.captureContainerLogs()));
    console.error("Import proof failure:", error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error");
    throw error;
  } finally {
    mark("Docker fixture teardown started");
    try { await fixture?.close(); }
    finally {
      mark("synthetic provider teardown started");
      await provider.close();
      mark("synthetic provider teardown complete");
    }
  }
});
