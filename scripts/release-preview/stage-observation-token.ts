/**
 * The operator's two steps for a rehearsal lane's observation token (coordinator 18:33Z 20 Nov).
 * The deploy credential cannot mint tokens and the account's one Secrets Store is production's, so:
 *
 * - mint: the operator's Cloudflare connection creates `basalt-test-rehearsal-<N>-pool-provider-
 *   observation` with production's props (Workers Containers Read on the account, nothing else),
 *   proves it, pipes its value on stdin into the stage job's secret, and keeps only its id, privately.
 * - delete: removes that token by the recorded id, proves it gone with a list read, and deletes the
 *   job's secret. It runs in the same step that removes the lane's paid parts.
 *
 * The value never reaches a log, a file, the tools service or an agent's context: the program seals
 * it to a one-off key only this process holds, and this process opens it straight into
 * `gh secret set` on stdin.
 */
import { spawn } from "node:child_process";
import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

export const observationPermission = "cfd39eebc07c4e3ea849e4b3d2644637";
export const laneTokenName = (lane: number) =>
  `basalt-test-rehearsal-${lane}-pool-provider-observation`;
export const laneSecretName = (lane: number) => `REHEARSAL_OBSERVATION_TOKEN_${lane}`;

/** Runs one program on the operator's Cloudflare connection and returns its result to this process. */
export interface OperatorTransport {
  run(program: string): Promise<unknown>;
}

const requireLane = (lane: number) => {
  if (!Number.isInteger(lane) || lane < 1 || lane > 9)
    throw new Error("A rehearsal lane is 1 to 9");
  return lane;
};
const requireAccount = (accountId: string) => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("An account id is 32 hex characters");
  return accountId;
};

/**
 * A one-off key pair for one mint. The program seals the value to the public half inside the
 * operator's sandbox, so the tools service only ever carries ciphertext; the private half never
 * leaves this process.
 */
export function mintKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return { publicJwk: publicKey.export({ format: "jwk" }), privateKey };
}

export function openSealed(sealed: string, privateKey: KeyObject) {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed, "base64"),
  ).toString("utf8");
}

/**
 * A lane token expires on its own: at a whole-second UTC instant after now and within 24 hours, so
 * a teardown that never runs still leaves no lasting credential.
 */
export function requireExpiry(expiresOn: string, now = Date.now()) {
  const at = Date.parse(expiresOn);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(expiresOn) ||
    !Number.isFinite(at) ||
    at <= now ||
    at > now + 24 * 3_600_000
  )
    throw new Error("A lane token's expiry is a UTC instant within the next 24 hours");
  return expiresOn;
}

/**
 * Proves it can seal before anything is created, refuses an existing token of that name, creates
 * it, proves its one policy, and returns its id and its value sealed to `publicJwk`.
 */
export function mintProgram(
  accountId: string,
  lane: number,
  publicJwk: object,
  expiresOn: string,
  now = Date.now(),
) {
  const target = {
    accountId: requireAccount(accountId),
    name: laneTokenName(requireLane(lane)),
    permission: observationPermission,
    expiresOn: requireExpiry(expiresOn, now),
    publicJwk,
  };
  return `async () => {
  const target = ${JSON.stringify(target)};
  const base = '/accounts/' + target.accountId;
  const request = async (options) => {
    const reply = await cloudflare.request(options);
    if (!reply || reply.success !== true) throw null;
    return reply;
  };
  // Every page, so a lane token on a later page is never missed.
  const tokens = async () => {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const reply = await request({method:'GET',path:base + '/tokens',query:{page,per_page:100}});
      const rows = Array.isArray(reply.result) ? reply.result : [];
      all.push(...rows);
      const pages = reply.result_info && reply.result_info.total_pages;
      if (Number.isInteger(pages) ? page >= pages : rows.length < 100) return all;
    }
    throw null;
  };
  const sealKey = await crypto.subtle.importKey('jwk', target.publicJwk,
    {name:'RSA-OAEP',hash:'SHA-256'}, false, ['encrypt']);
  const seal = async (text) => {
    const bytes = new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'}, sealKey,
      new TextEncoder().encode(text)));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  try {
    // Sealing must work before a token exists, or its value could not leave the sandbox safely.
    await seal('probe');
  } catch {
    return {outcome:'refused_sealing'};
  }
  // Once a token exists its id goes back on every outcome, so it can always be deleted by id.
  let tokenId = null;
  try {
    if ((await tokens()).some(row => row && row.name === target.name))
      return {outcome:'refused_existing'};
    const created = (await request({method:'POST',path:base + '/tokens',body:{name:target.name,
      expires_on:target.expiresOn,
      policies:[{effect:'allow',permission_groups:[{id:target.permission}],
        resources:{['com.cloudflare.api.account.' + target.accountId]:'*'}}]}})).result;
    if (created && /^[a-f0-9]{32}$/.test(created.id || '')) tokenId = created.id;
    if (!tokenId || typeof created.value !== 'string') return {outcome:'unknown_create', tokenId};
    const actual = (await request({method:'GET',path:base + '/tokens/' + tokenId})).result;
    const policy = actual && Array.isArray(actual.policies) && actual.policies.length === 1 && actual.policies[0];
    const owned = actual && actual.id === tokenId && actual.name === target.name && policy &&
      policy.effect === 'allow' && policy.permission_groups.length === 1 &&
      policy.permission_groups[0].id === target.permission &&
      Object.keys(policy.resources || {}).length === 1 &&
      policy.resources['com.cloudflare.api.account.' + target.accountId] === '*' &&
      Date.parse(actual.expires_on) === Date.parse(target.expiresOn);
    if (!owned) return {outcome:'refused_ownership', tokenId};
    const sealed = await seal(created.value);
    created.value = null;
    return {outcome:'minted', tokenId, sealed};
  } catch {
    // Provider messages may echo a value. Never return any part of an exception.
    return {outcome:'unknown', tokenId};
  }
}`;
}

/**
 * Deletes the lane token, by the recorded id when there is one, else the one token with the lane's
 * name (exactly one, or it refuses), then proves no token has that id or name on any page.
 */
export function deleteProgram(accountId: string, lane: number, tokenId: string | null) {
  if (tokenId !== null && !/^[a-f0-9]{32}$/u.test(tokenId))
    throw new Error("A token id is 32 hex characters");
  const target = {
    accountId: requireAccount(accountId),
    name: laneTokenName(requireLane(lane)),
    tokenId,
  };
  return `async () => {
  const target = ${JSON.stringify(target)};
  const base = '/accounts/' + target.accountId;
  const request = async (options) => {
    const reply = await cloudflare.request(options);
    if (!reply || reply.success !== true) throw null;
    return reply;
  };
  // Every page, so a lane token on a later page is never missed.
  const tokens = async () => {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const reply = await request({method:'GET',path:base + '/tokens',query:{page,per_page:100}});
      const rows = Array.isArray(reply.result) ? reply.result : [];
      all.push(...rows);
      const pages = reply.result_info && reply.result_info.total_pages;
      if (Number.isInteger(pages) ? page >= pages : rows.length < 100) return all;
    }
    throw null;
  };
  try {
    const before = await tokens();
    const named = before.filter(item => item && item.name === target.name);
    const row = target.tokenId === null
      ? (named.length === 1 ? named[0] : undefined)
      : before.find(item => item && item.id === target.tokenId);
    if (target.tokenId === null && named.length > 1) return {outcome:'refused_inventory'};
    if (row && row.name !== target.name) return {outcome:'refused_ownership'};
    if (row) await request({method:'DELETE',path:base + '/tokens/' + row.id});
    const gone = row ? row.id : target.tokenId;
    const left = (await tokens()).filter(item => item && (item.id === gone || item.name === target.name));
    return {outcome: left.length ? 'still_present' : 'gone', present: left.length};
  } catch {
    return {outcome:'unknown'};
  }
}`;
}

type Spawn = typeof spawn;

/** `gh secret set <name>` with the value on stdin only; it is never an argument or a file. */
export function setJobSecret(name: string, value: string, run: Spawn = spawn) {
  return new Promise<void>((done, fail) => {
    const child = run("gh", ["secret", "set", name, "-R", "JustYannicc/basalt"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`gh secret set ${name} exited ${code}`)),
    );
    child.stdin?.end(value);
  });
}

export function deleteJobSecret(name: string, run: Spawn = spawn) {
  return new Promise<void>((done, fail) => {
    const child = run("gh", ["secret", "delete", name, "-R", "JustYannicc/basalt"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`gh secret delete ${name} exited ${code}`)),
    );
  });
}

/** One operator step: mint, prove, set the job's secret, keep the id privately. Prints no value. */
export async function mintLaneToken(input: {
  accountId: string;
  lane: number;
  expiresOn: string;
  record: string;
  transport: OperatorTransport;
  setSecret?: typeof setJobSecret;
}) {
  const keys = mintKeys();
  const reply = (await input.transport.run(
    mintProgram(input.accountId, input.lane, keys.publicJwk, input.expiresOn),
  )) as {
    outcome?: unknown;
    tokenId?: unknown;
    sealed?: unknown;
  } | null;
  const tokenId = typeof reply?.tokenId === "string" ? reply.tokenId : undefined;
  // The id is recorded whatever happened next, so a half-done mint can still be deleted by it.
  if (tokenId)
    await writeFile(input.record, `${JSON.stringify({ lane: input.lane, tokenId })}\n`, {
      mode: 0o600,
    });
  if (reply?.outcome !== "minted" || typeof reply.sealed !== "string" || !reply.sealed)
    return { outcome: String(reply?.outcome ?? "unknown"), recorded: Boolean(tokenId) };
  await (input.setSecret ?? setJobSecret)(
    laneSecretName(input.lane),
    openSealed(reply.sealed, keys.privateKey),
  );
  return { outcome: "minted", recorded: true, secret: laneSecretName(input.lane) };
}

/**
 * One operator step: delete by the recorded id (or, with no record, the lane's one token by name),
 * prove it gone, delete the job's secret.
 */
export async function deleteLaneToken(input: {
  accountId: string;
  lane: number;
  record: string;
  transport: OperatorTransport;
  deleteSecret?: typeof deleteJobSecret;
}) {
  const text = await readFile(input.record, "utf8").catch(() => undefined);
  const recorded =
    text === undefined ? undefined : (JSON.parse(text) as { lane?: unknown; tokenId?: unknown });
  if (recorded && (recorded.lane !== input.lane || typeof recorded.tokenId !== "string"))
    throw new Error("The record names another lane or no token");
  const reply = (await input.transport.run(
    deleteProgram(input.accountId, input.lane, (recorded?.tokenId as string | undefined) ?? null),
  )) as { outcome?: unknown } | null;
  if (reply?.outcome !== "gone") return { outcome: String(reply?.outcome ?? "unknown") };
  await (input.deleteSecret ?? deleteJobSecret)(laneSecretName(input.lane));
  await rm(input.record, { force: true });
  return { outcome: "gone", secretDeleted: laneSecretName(input.lane), byName: !recorded };
}

type Json = Record<string, unknown>;
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Json)[key] : undefined;

/**
 * The operator's Cloudflare connection through the tools service's MCP endpoint, as the pool's
 * credential bootstrap uses it (`tools.cloudflare.mcp.execute`). Its approval pause is accepted
 * only for the exact program this process submitted; any other pause refuses.
 */
export function toolsServiceTransport(input: {
  url: string;
  headers: Record<string, string>;
  connection: string;
  accountId: string;
  fetch?: typeof fetch;
}): OperatorTransport {
  const send = input.fetch ?? fetch;
  return {
    run: async (program: string) => {
      let session: string | null = null;
      let id = 0;
      const rpc = async (method: string, params?: unknown) => {
        const response = await send(input.url, {
          method: "POST",
          headers: {
            ...input.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(session ? { "Mcp-Session-Id": session } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(params === undefined && method.startsWith("notifications/") ? {} : { id: ++id }),
            method,
            ...(params === undefined ? {} : { params }),
          }),
        });
        session = response.headers.get("Mcp-Session-Id") ?? session;
        if (!response.ok) throw new Error(`The tools service answered HTTP ${response.status}`);
        const text = await response.text();
        const body = text.includes("data:")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
          : text;
        return body.trim() ? (JSON.parse(body) as Json) : {};
      };
      const toolText = (reply: Json) => {
        const content = field(field(reply, "result"), "content");
        const text = Array.isArray(content) ? field(content[0], "text") : undefined;
        if (typeof text !== "string") throw new Error("The tools service returned no tool result");
        return JSON.parse(text) as Json;
      };
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stage-observation-token", version: "1" },
      });
      await rpc("notifications/initialized").catch(() => ({}));
      let outcome = toolText(
        await rpc("tools/call", {
          name: "call",
          arguments: {
            calls: {
              path: "tools.cloudflare.mcp.execute",
              input: {
                accountId: input.connection,
                input: { account_id: input.accountId, code: program },
              },
            },
          },
        }),
      );
      if (field(outcome, "status") === "approval-required") {
        const paused = field(field(outcome, "invocation"), "input");
        const pending = field(paused, "input");
        if (
          field(pending, "code") !== program ||
          field(pending, "account_id") !== input.accountId ||
          field(paused, "accountId") !== input.connection
        )
          throw new Error("The paused program is not the one this process submitted");
        outcome = toolText(
          await rpc("tools/call", {
            name: "resume",
            arguments: {
              requestId: field(outcome, "requestId"),
              response: { action: "accept", content: {} },
            },
          }),
        );
      }
      const execution = field(outcome, "execution");
      const call = field(execution, "value");
      if (field(outcome, "status") !== "completed" || field(execution, "ok") !== true)
        throw new Error(
          `The operator program did not complete (${String(field(outcome, "status"))})`,
        );
      if (field(call, "ok") !== true) throw new Error("The operator program's call failed");
      const content = field(field(call, "value"), "content");
      const text = Array.isArray(content) ? field(content[0], "text") : undefined;
      return typeof text === "string" ? (JSON.parse(text) as unknown) : null;
    },
  };
}

/**
 * `stage-observation-token.ts mint <lane> <account id> <connection id> <expires, UTC>` or
 * `delete <lane> <account id> <connection id>`; prints outcomes only.
 */
async function main(args: string[]) {
  const [command, laneText, accountId, connection, expiresOn] = args;
  const lane = Number(laneText);
  if (
    (command !== "mint" && command !== "delete") ||
    !accountId ||
    !connection ||
    (command === "mint" && !expiresOn)
  )
    throw new Error(
      "Usage: stage-observation-token.ts mint <lane> <account id> <connection id> <expires> | delete <lane> <account id> <connection id>",
    );
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const config = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")) as {
    mcpServers?: { signalbox?: { url?: string; headers?: Record<string, string> } };
  };
  const server = config.mcpServers?.signalbox;
  if (!server?.url) throw new Error("No tools service endpoint is configured");
  const transport = toolsServiceTransport({
    url: server.url,
    headers: server.headers ?? {},
    connection,
    accountId,
  });
  const record = join(
    homedir(),
    ".codex/artifacts/basalt-v1",
    `lane-${lane}-observation-token.json`,
  );
  const result =
    command === "mint"
      ? await mintLaneToken({ accountId, lane, expiresOn: expiresOn!, record, transport })
      : await deleteLaneToken({ accountId, lane, record, transport });
  console.log(JSON.stringify(result));
}

if (import.meta.main ?? process.argv[1]?.endsWith("stage-observation-token.ts"))
  await main(process.argv.slice(2)).catch((error: unknown) => {
    // Tool replies can echo inputs; print only the message's first line.
    console.error(String(error instanceof Error ? error.message : error).split("\n")[0]);
    process.exitCode = 1;
  });
