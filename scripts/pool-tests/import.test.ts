import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderProduct } from "./provider-product.mjs";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { PoolControl } from "../../src/pool/attribution.ts";
import { HomeClient, PoolHome, poolGroupPrefix } from "../../src/pool/control.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { importAccounts, ImportFailure, type ImportConfig } from "../cutover/import.ts";
import { SyntheticOAuthProvider } from "./import-fixture.ts";
import { migrateCodexWebSockets } from "../../src/pool/codex-websockets.ts";
import { MemoryStorage, SharingFixture } from "./sharing-fixture.ts";

const signingKey = "ab".repeat(32);
const otherPool = "fixture-neighbor-pool";
const expires = "2099-01-01T00:00:00.000Z";

class ControllerStorage extends MemoryStorage {
  async getAlarm(): Promise<number | null> {
    return null;
  }
  async setAlarm(_time: number): Promise<void> {}
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.synthetic-signature`;
}

test(
  "cutover importer assigns synthetic Claude and Codex logins and verifies real pinned node usage",
  { timeout: 420_000 },
  async () => {
    const provider = new SyntheticOAuthProvider();
    let fixture: SharingFixture | undefined;
    const bridgeEvents: string[] = [];
    const bridgeStages: string[] = [];
    const bridgeFailures: string[] = [];
    const importedIds: string[] = [];
    const postUploadCatalogs: { status: number; ids: string[] }[] = [];
    const postUploadCredentialStates: {
      provider: string;
      status: string | null;
      disabled: boolean;
      unavailable: boolean;
    }[] = [];
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
      await withProviderProduct(homeClient, async (product) => {
        const pool = product.pool;
        const owner = product.actors.owner.userId;
        const computerHome = new ComputerHome(homeClient);
        await computerHome.group(otherPool);
        const api = await computerHome.mint(owner, pool, "synthetic-import-proof");
        const poolToken = await signPoolToken(signingKey, {
          pool,
          owner,
          organization: product.actors.organization.id,
        });
        const control = new PoolControl(new ControllerStorage(), {
          signingKey,
          home: (path, init) => fixture!.fetchHome(path, init),
        });

        const codexToken = jwt({
          exp: Math.floor(Date.parse(expires) / 1000),
          email: "synthetic-codex@example.invalid",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "synthetic-codex-account",
            chatgpt_user_id: "synthetic-codex-user",
            chatgpt_plan_type: "plus",
          },
        });
        const diagnosticRedactions = [
          api.key,
          poolToken,
          codexToken,
          signingKey,
          "sk-ant-oat01-synthetic-claude",
          "synthetic-claude-refresh",
          "synthetic-codex-refresh",
        ];
        fixture!.addLogRedactions(diagnosticRedactions);
        const config: ImportConfig = {
          origin: product.origin,
          poolToken,
          owner,
          apiKey: api.key,
          organization: product.actors.organization.id,
          poolApp: pool,
          cookie: product.actors.owner.cookies,
          accounts: [
            {
              providerApp: (await product.provider("anthropic")).id,
              creation: crypto.randomUUID(),
              file: {
                type: "claude",
                email: "synthetic-claude@example.invalid",
                access_token: "sk-ant-oat01-synthetic-claude",
                refresh_token: "synthetic-claude-refresh",
                expired: expires,
                proxy_url: provider.url,
              },
              model: "claude-sonnet-4-5-20250929",
            },
            {
              providerApp: (await product.provider("openai")).id,
              creation: crypto.randomUUID(),
              file: {
                type: "codex",
                email: "synthetic-codex@example.invalid",
                access_token: codexToken,
                id_token: codexToken,
                refresh_token: "synthetic-codex-refresh",
                expired: expires,
                expires_at: expires,
                account_id: "synthetic-codex-account",
                proxy_url: provider.url,
              },
              model: "gpt-5.6-luna",
            },
          ],
        };

        const savedAccounts = new Map<string, string>();
        let loseProviderLink = true;
        const bridge: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname.startsWith("/pool/v1/") || url.pathname.startsWith("/api/")) {
            bridgeStages.push(`${request.method} ${url.pathname} started`);
            const response = url.pathname.startsWith("/api/")
              ? await fetch(request)
              : await control.handle(request);
            const appId = url.pathname.split("/")[5];
            if (url.pathname.endsWith("/import-login-file") && response.ok) {
              const saved = (await response.clone().json()) as { id: string };
              const previous = savedAccounts.get(appId!);
              if (previous !== undefined) assert.equal(saved.id, previous);
              savedAccounts.set(appId!, saved.id);
            }
            if (request.method === "PUT" && appId === pool && response.ok)
              await product.reconcile(
                url.pathname.split("/").at(-2)!,
                url.pathname.split("/").at(-1)!,
              );
            bridgeEvents.push(`${request.method} ${url.pathname} ${response.status}`);
            if (request.method === "PUT" && appId !== pool && response.ok && loseProviderLink) {
              loseProviderLink = false;
              await response.body?.cancel();
              return new Response(null, { status: 503 });
            }
            if (request.method === "PUT" && appId === pool && response.ok) {
              const lab = url.pathname.split("/").at(-2);
              const account = config.accounts.find(
                (entry) => entry.file.type === (lab === "openai" ? "codex" : "claude"),
              );
              assert.ok(account);
              const provider = account.file.type;
              assert.ok(
                provider === "claude" || provider === "codex",
                "Synthetic login provider must be claude or codex",
              );
              const imported = product.references.get(provider);
              assert.ok(typeof imported === "string");
              if (!importedIds.includes(imported)) importedIds.push(imported);
              const files = await fixture!.data<{
                files?: {
                  id?: unknown;
                  provider?: unknown;
                  type?: unknown;
                  status?: unknown;
                  disabled?: unknown;
                  unavailable?: unknown;
                }[];
              }>("/credentials");
              const credential = files.files?.find((file) => file.id === imported);
              postUploadCredentialStates.push({
                provider,
                status: typeof credential?.status === "string" ? credential.status : null,
                disabled: credential?.disabled === true,
                unavailable: credential?.unavailable === true,
              });
              const membership = await homeClient.allMembership();
              const target = membership.groups.find(
                (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
              );
              const neighbor = membership.groups.find(
                (group) => group.channel_name === `${poolGroupPrefix}${otherPool}`,
              );
              const assignedGroups = membership.members
                .filter((member) => member.auth_id === imported)
                .map((member) => member.channel_group_id);
              postUploadAssignments.push({
                provider,
                target: !!target && assignedGroups.includes(target.id),
                neighbor: !!neighbor && assignedGroups.includes(neighbor.id),
              });
              const catalog = await fetch(`${fixture!.node}/v1/models`, {
                headers: { Authorization: `Bearer ${api.key}` },
                signal: AbortSignal.timeout(10_000),
              });
              const payload = (await catalog.json().catch(() => ({}))) as {
                data?: { id?: unknown }[];
              };
              const ids = Array.isArray(payload.data)
                ? payload.data.flatMap((model) => (typeof model.id === "string" ? [model.id] : []))
                : [];
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
              body:
                request.method === "GET" || request.method === "HEAD"
                  ? undefined
                  : new Uint8Array(await request.arrayBuffer()),
              signal: request.signal,
            });
            let event = `${request.method} ${url.pathname} ${response.status}`;
            if (!response.ok) {
              let body = await response.clone().text();
              for (const secret of [
                api.key,
                poolToken,
                "sk-ant-oat01-synthetic-claude",
                "synthetic-claude-refresh",
                "synthetic-codex-refresh",
                codexToken,
              ]) {
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
        await assert.rejects(
          importAccounts(config, { fetch: bridge }),
          (error: unknown) => error instanceof ImportFailure && error.stage === "upload",
        );
        const assertLinks = async () => {
          const poolLinks = await product.links(pool);
          for (const account of config.accounts) {
            const lab = account.file.type === "codex" ? "openai" : "anthropic";
            const id = savedAccounts.get(account.providerApp);
            assert.ok(id);
            const providerLinks = await product.links(account.providerApp);
            for (const links of [providerLinks, poolLinks]) {
              assert.equal(
                links.filter((link) => link.requirement === lab && link.account.id === id).length,
                1,
              );
            }
          }
        };
        assert.deepEqual(await importAccounts(config, { fetch: bridge }), { verified: 2 });
        await assertLinks();
        const firstSaved = [...savedAccounts.entries()];
        const firstReferences = [...importedIds];
        assert.deepEqual(await importAccounts(config, { fetch: bridge }), { verified: 2 });
        await assertLinks();
        assert.deepEqual([...savedAccounts.entries()], firstSaved);
        assert.deepEqual(importedIds, firstReferences);
        assert.equal(importedIds.length, 2);
        assert.equal(new Set(importedIds).size, 2);
        for (const id of importedIds) assert.match(id, /^[0-9a-f-]{36}$/i);
        const credentialFiles = (await homeClient.data("/credentials")).files as Record<
          string,
          unknown
        >[];
        const codexFiles = credentialFiles.filter(
          (file) => importedIds.includes(String(file.id)) && file.provider === "codex",
        );
        assert.equal(codexFiles.length, 1);
        assert.equal(
          codexFiles[0]!.websockets,
          true,
          "Codex imports must enable and read back the pinned Home transport flag",
        );
        // Simulate an existing credential and prove the same supported field API migrates it.
        const transportPatch = await homeClient.data("/credentials/fields", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
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
        const target = membership.groups.find(
          (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
        );
        const neighbor = membership.groups.find(
          (group) => group.channel_name === `${poolGroupPrefix}${otherPool}`,
        );
        assert.ok(target);
        assert.ok(neighbor);
        const importedMembership = membership.members.filter((member) =>
          importedIds.includes(member.auth_id),
        );
        assert.deepEqual(
          new Set(importedMembership.map((member) => member.auth_id)),
          new Set(importedIds),
        );
        assert.deepEqual(
          new Set(importedMembership.map((member) => member.channel_group_id)),
          new Set([target.id]),
        );
        assert.ok(importedMembership.every((member) => member.channel_group_id !== neighbor.id));

        const view = await new PoolHome(homeClient, pool).view(true);
        assert.deepEqual(view.accounts.map((account) => account.provider).sort(), [
          "claude",
          "codex",
        ]);
        const providerPathname = (path: string) =>
          new URL(path, "https://synthetic.invalid").pathname;
        assert.ok(
          provider.requests.some(
            (request) =>
              request.authority === "api.anthropic.com" &&
              request.method === "POST" &&
              providerPathname(request.path) === "/v1/messages",
          ),
        );
        assert.ok(
          provider.requests.some(
            (request) =>
              request.authority === "chatgpt.com" &&
              request.method === "POST" &&
              providerPathname(request.path).endsWith("/responses"),
          ),
        );
        assert.equal(
          bridgeEvents.filter((event) => event.includes("/import-login-file 200")).length,
          5,
        );
        assert.equal(
          bridgeEvents.filter((event) => event === "POST /v1/chat/completions 200").length,
          4,
        );
        console.log(
          "PASS: provider imports and explicit pool selection reached real pinned Home/node with exact-session account proof",
        );
      });
    } catch (error) {
      console.error(
        "Import proof diagnostics:",
        JSON.stringify({
          stage,
          stages,
          bridgeStages,
          bridgeEvents,
          bridgeFailures,
          postUploadCatalogs,
          postUploadCredentialStates,
          postUploadAssignments,
          providerRequests: provider.requests.map(({ authority, method, path }) => ({
            authority,
            method,
            path,
          })),
        }),
      );
      if (fixture)
        console.error("Pinned pool logs:", JSON.stringify(await fixture.captureContainerLogs()));
      console.error(
        "Import proof failure:",
        error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error",
      );
      throw error;
    } finally {
      mark("Docker fixture teardown started");
      try {
        await fixture?.close();
      } finally {
        mark("synthetic provider teardown started");
        await provider.close();
        mark("synthetic provider teardown complete");
      }
    }
  },
);
