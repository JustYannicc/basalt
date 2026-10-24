import { signEnvelope } from "../pool/token.ts";

interface Service { fetch(request: Request): Promise<Response> }
export interface SetupEnv {
  TOOLS_SERVICE: Service;
  POOL_SERVICE: Service;
  POOL_APP_SIGNING_KEY: string;
}

const security = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
class SetupError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function json(value: unknown, status = 200, extra = {}): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { ...security, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 8192): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
async function body(response: Response): Promise<Record<string, unknown>> {
  try { return record(await response.json()); }
  catch { throw new SetupError(502, "Setup service returned an invalid response."); }
}

async function inputBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 16_384) {
          await reader.cancel();
          throw new SetupError(413, "Setup request is too large.");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new SetupError(400, "Invalid setup request."); }
}

/** Only public computer metadata can leave the browser endpoints. */
function computerSummary(value: unknown): Record<string, unknown> {
  const input = record(value);
  const fields = ["id", "name", "poolId", "state", "createdAt", "firstModelRequestAt", "firstToolCallAt", "revokedAt"];
  if (!text(input.id, 512)) throw new SetupError(502, "Setup service returned an invalid computer.");
  if (fields.some((key) => key in input && input[key] !== null && !text(input[key])))
    throw new SetupError(502, "Setup service returned an invalid computer.");
  return Object.fromEntries(fields.filter((key) => key in input).map((key) => [key, input[key]]));
}

/** Cookie authentication stays on the public origin expected by native Better Auth. */
function native(request: Request, env: SetupEnv, path: string, input?: unknown): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);
  if (input !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", new URL(request.url).origin);
  }
  return env.TOOLS_SERVICE.fetch(new Request(new URL(`/api/auth/${path}`, request.url), {
    method: input === undefined ? "GET" : "POST", headers, redirect: "manual",
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
}
async function user(request: Request, env: SetupEnv): Promise<string> {
  if (!request.headers.get("cookie")) throw new SetupError(401, "Sign in to set up this computer.");
  const response = await native(request, env, "get-session?disableCookieCache=true&disableRefresh=true");
  if (!response.ok) throw new SetupError(response.status === 401 ? 401 : 502, "Could not check your session.");
  const session = await body(response);
  const account = record(session.user);
  if (!text(account.id, 512)) throw new SetupError(401, "Sign in to set up this computer.");
  if (account.emailVerified !== true) throw new SetupError(403, "Verify your email before setup.");
  return account.id;
}

/** The action binds the signed request to its endpoint; all timestamps are milliseconds. */
async function pool(request: Request, env: SetupEnv, action: string, payload: Record<string, unknown>): Promise<Response> {
  const envelope = await signEnvelope(env.POOL_APP_SIGNING_KEY, "sbs1", {
    ...payload, action, expiresAt: Date.now() + 30_000,
  });
  const response = await env.POOL_SERVICE.fetch(new Request(new URL(`/__setup/v1/${action}`, request.url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }), redirect: "manual",
  }));
  if (!response.ok) {
    const status = [400, 401, 403, 404, 409, 410, 429].includes(response.status) ? response.status : 502;
    throw new SetupError(status, action === "claim" ? "Setup link is unavailable. Create a new link."
      : action === "refresh" && status === 409 ? "This link cannot be refreshed. Revoke this computer, then create a new setup."
      : status === 403 ? "Set up this computer with your own pool. Shared pools come with pool sharing."
      : "Could not complete setup. Try again.");
  }
  return response;
}

async function deleteTools(request: Request, env: SetupEnv, keyId: string): Promise<void> {
  const response = await native(request, env, "api-key/delete", { keyId });
  const result = await body(response);
  if (response.ok && result.success === true) return;
  // Native delete conceals foreign keys with the same code. The signed pool record owns keyId.
  if (response.status === 404 && result.code === "KEY_NOT_FOUND") return;
  throw new SetupError(502, "Could not revoke the tools token. Retry removing this computer.");
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Download to a private temporary directory, execute the installer, then erase it. */
function commands(origin: string, args: string[]): { command: string; powershellCommand: string } {
  const script = `${origin}/setup/client.mjs`;
  const bootstrap = `import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{spawnSync}from'node:child_process';if(Number(process.versions.node.split('.')[0])<18)throw Error('Node.js 18 or newer is required');const d=await mkdtemp(join(tmpdir(),'computer-setup-'));try{const r=await fetch(process.argv[1]);if(!r.ok)throw Error('Installer download failed');const f=join(d,'client.mjs');await writeFile(f,await r.text(),{mode:0o600});const p=spawnSync(process.execPath,[f,...process.argv.slice(2)],{stdio:'inherit'});process.exitCode=p.status??1}finally{await rm(d,{recursive:true,force:true})}`;
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const powershellCommand = `& { $ErrorActionPreference='Stop'; if ((& node -p "Number(process.versions.node.split('.')[0])") -lt 18) { throw 'Node.js 18 or newer is required' }; $d=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()); New-Item -ItemType Directory -Path $d | Out-Null; try { $a=Get-Acl $d; $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.SetAccessRule($r); Set-Acl -Path $d -AclObject $a; $f=Join-Path $d 'client.mjs'; Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(script)} -OutFile $f; & node $f ${args.map(psQuote).join(" ")}; if ($LASTEXITCODE -ne 0) { throw 'Setup command failed' } } finally { Remove-Item -LiteralPath $d -Recurse -Force } }`;
  return {
    command: `node --input-type=module -e ${quote(bootstrap)} ${[script, ...args].map(quote).join(" ")}`,
    powershellCommand,
  };
}

function undo(origin: string): string {
  return `Undo this computer's setup with Node.js 18 or newer. Run this command, which removes the marked entries and restores the backups: ${commands(origin, ["--undo"]).command}`;
}

async function createLink(request: Request, env: SetupEnv, payload: Record<string, unknown>, selection: Record<string, unknown>): Promise<Response> {
  if (selection.owner !== payload.user || !text(selection.organization, 512))
    throw new SetupError(403, "Set up this computer with your own pool. Shared pools come with pool sharing.");
  const organization = selection.organization;
  const created = await native(request, env, "api-key/create", { name: payload.name, metadata: { organization } });
  if (!created.ok) throw new SetupError(502, "Could not create the tools token. Try again.");
  const key = await body(created);
  if (!text(key.id, 512)) throw new SetupError(502, "Could not create the tools token. Try again.");
  try {
    if (!text(key.key)) throw new SetupError(502, "Could not create the tools token. Try again.");
    const result = await body(await pool(request, env, "links", { ...payload, toolsToken: key.key, toolsKeyId: key.id }));
    return linkResponse(request, result);
  } catch (error) {
    // Revoke the new personal token if the handoff fails.
    await deleteTools(request, env, key.id);
    throw error;
  }
}

function linkResponse(request: Request, result: Record<string, unknown>): Response {
  const expiry = typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : NaN;
  if (!text(result.token, 512) || !/^[A-Za-z0-9_-]+$/.test(result.token) ||
    !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 300_000 ||
    !text(record(result.computer).id, 512)) throw new SetupError(502, "Could not create the setup link. Try again.");
  const origin = new URL(request.url).origin;
  const link = `${origin}/setup/claim/${result.token}`;
  return json({
    computer: computerSummary(result.computer), computerId: record(result.computer).id,
    prompt: `Set up Claude Code and Codex on this computer. Open ${link} for the one-time instructions and credentials. Back up each file first, preserve other settings, then apply the instructions without another confirmation. Tell me to restart and send a message when done. Requires Node.js 18 or newer.`,
    ...commands(origin, ["--link", link]), undoPrompt: undo(origin), expiresAt: result.expiresAt,
  });
}

/** Only /setup/v1/* and /setup/claim/:token belong to this adapter. */
export async function handleSetup(request: Request, env: SetupEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.headers.has("authorization")) throw new SetupError(403, "Setup requires a browser session.");
    const claim = /^\/setup\/claim\/([A-Za-z0-9_-]{1,512})$/.exec(url.pathname);
    const computer = /^\/setup\/v1\/computers\/([A-Za-z0-9_-]{1,512})$/.exec(url.pathname);
    const method = claim ? "GET" : url.pathname === "/setup/v1/links" ? "POST"
      : url.pathname === "/setup/v1/computers" ? "GET" : computer ? "DELETE" : null;
    if (!method) throw new SetupError(404, "Setup route not found.");
    if (request.method !== method) return json({ error: "Method not allowed." }, 405, { Allow: method });
    if (claim) {
      const format = url.searchParams.get("format") ?? (request.headers.get("accept")?.includes("application/json") ? "json" : "markdown");
      if (format !== "json" && format !== "markdown") throw new SetupError(400, "Unsupported setup format.");
      const response = await pool(request, env, "claim", { token: claim[1], format });
      return new Response(response.body, {
        headers: { ...security, "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8" },
      });
    }
    if (method !== "GET" && request.headers.get("origin") !== url.origin)
      throw new SetupError(403, "Open setup on this site's own page.");
    let input: Record<string, unknown>;
    if (method === "POST") {
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        throw new SetupError(415, "Setup requires JSON.");
      input = await inputBody(request);
      const refresh = input.computerId !== undefined;
      if (Object.keys(input).some((key) => !["intent", "name", "computerId"].includes(key)) ||
        (refresh ? !text(input.computerId, 512) || !/^[A-Za-z0-9_-]+$/.test(input.computerId) || input.name !== undefined
          : !text(input.name, 60) || !input.name.trim() || /[\u0000-\u001f\u007f]/.test(input.name)))
        throw new SetupError(400, "Choose a computer name of 1 to 60 characters.");
    } else input = { intent: url.searchParams.get("intent") };
    if (!text(input.intent)) throw new SetupError(400, "A setup intent is required.");
    const payload = { ...input, user: await user(request, env) };
    const selection = await body(await pool(request, env, "validate", { user: payload.user, intent: input.intent }));
    if (method === "POST") {
      if (input.computerId !== undefined) return linkResponse(request, await body(await pool(request, env, "refresh", {
        user: payload.user, intent: input.intent, id: input.computerId,
      })));
      return await createLink(request, env, payload, selection);
    }
    if (method === "GET") {
      const result = await body(await pool(request, env, "computers", payload));
      if (!Array.isArray(result.computers)) throw new SetupError(502, "Could not list computers.");
      return json({ computers: result.computers.map(computerSummary), undoPrompt: undo(url.origin) });
    }
    const revoke = { ...payload, id: computer![1] };
    const result = await body(await pool(request, env, "revoke", revoke));
    if (!text(result.toolsKeyId, 512)) throw new SetupError(502, "Could not revoke this computer. Try again.");
    await deleteTools(request, env, result.toolsKeyId);
    await pool(request, env, "revoked", revoke);
    return json({ success: true });
  } catch (error) {
    return error instanceof SetupError ? json({ error: error.message }, error.status)
      : json({ error: "Setup is temporarily unavailable. Try again." }, 502);
  }
}
