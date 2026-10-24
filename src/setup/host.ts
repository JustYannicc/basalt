import {
  body, inputBody, json, native, pool, record, SetupError, security, text, user, type SetupEnv,
} from "./session.ts";
import { emitProductEvent } from "./product-events.ts";
export type { SetupEnv } from "./session.ts";

/** Only public computer metadata can leave the browser endpoints. */
function computerSummary(value: unknown): Record<string, unknown> {
  const input = record(value);
  const fields = ["id", "name", "poolId", "state", "createdAt", "firstModelRequestAt", "firstToolCallAt", "revokedAt", "removedAt"];
  if (!text(input.id, 512)) throw new SetupError(502, "Setup service returned an invalid computer.");
  if (fields.some((key) => key in input && input[key] !== null && !text(input[key])))
    throw new SetupError(502, "Setup service returned an invalid computer.");
  return Object.fromEntries(fields.filter((key) => key in input).map((key) => [key, input[key]]));
}
/** Pool names are people's own labels; ids are app ids. Nothing else about a pool leaves. */
function poolChoices(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SetupError(502, "Setup service returned invalid pools.");
  return value.map((entry) => {
    const input = record(entry);
    if (!text(input.id, 512) || typeof input.name !== "string" || input.name.length > 200 || typeof input.mine !== "boolean")
      throw new SetupError(502, "Setup service returned invalid pools.");
    return { id: input.id, name: input.name, mine: input.mine };
  });
}

interface OwnPool { pool?: string; organization: string }
/**
 * The organization holding the person's own pool, and that pool when the tools service confirms they
 * created it, read with their own session. Tools are always theirs, never a pool's: a computer on a
 * shared pool still gets a tools token pinned to this organization. A deleted pool keeps its record,
 * so the organization stays usable without it. Undefined until their pool is installed.
 */
async function ownPool(request: Request, env: SetupEnv, person: string): Promise<OwnPool | undefined> {
  const response = await native(request, env, "organization/list");
  if (!response.ok) throw new SetupError(502, "Could not find your own organization. Try again.");
  const organizations: unknown = await response.json().catch(() => undefined);
  if (!Array.isArray(organizations)) throw new SetupError(502, "Could not find your own organization. Try again.");
  for (const organization of organizations.map(record)) {
    let metadata: unknown = organization.metadata;
    if (typeof metadata === "string") { try { metadata = JSON.parse(metadata); } catch { metadata = undefined; } }
    const pools = record(record(metadata).basaltPools);
    const pool = Object.hasOwn(pools, person) ? record(pools[person]).app : undefined;
    if (!text(pool, 512) || !text(organization.id, 512)) continue;
    // Metadata is only a pointer. The tools service's own access record must say the person created it.
    const access = await native(request, env,
      `/api/organizations/${encodeURIComponent(organization.id)}/apps/${encodeURIComponent(pool)}/access`);
    if (access.ok) {
      if ((await body(access)).creator === person) return { pool, organization: organization.id };
      continue;
    }
    await access.body?.cancel();
    if (access.status === 403 || access.status === 404) return { organization: organization.id };
    throw new SetupError(502, "Could not check your own pool. Try again.");
  }
  return undefined;
}
/** Lists still work while the organization list is unavailable; only minting needs it. */
const ownPoolIfAvailable = (request: Request, env: SetupEnv, person: string) =>
  ownPool(request, env, person).catch(() => undefined);

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

async function createLink(request: Request, env: SetupEnv, payload: Record<string, unknown>, selection: Record<string, unknown>, own: OwnPool | undefined): Promise<Response> {
  const organization = own?.organization;
  if (!organization) throw new SetupError(409, "Your own pool is still being set up. Try again in a minute.");
  const created = await native(request, env, "api-key/create", { name: payload.name, metadata: { organization } });
  if (!created.ok) throw new SetupError(502, "Could not create the tools token. Try again.");
  const key = await body(created);
  if (!text(key.id, 512)) throw new SetupError(502, "Could not create the tools token. Try again.");
  try {
    if (!text(key.key)) throw new SetupError(502, "Could not create the tools token. Try again.");
    const result = await body(await pool(request, env, "links", { ...payload, ...own?.pool && { own }, toolsToken: key.key, toolsKeyId: key.id }));
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
    const switching = /^\/setup\/v1\/computers\/([A-Za-z0-9_-]{1,512})\/pool$/.exec(url.pathname);
    const method = claim ? "GET" : url.pathname === "/setup/v1/links" || switching ? "POST"
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
      if (switching) {
        if (Object.keys(input).some((key) => !["intent", "pool"].includes(key)) || !text(input.pool, 512))
          throw new SetupError(400, "Choose a pool for this computer.");
        if (!text(input.intent)) throw new SetupError(400, "A setup intent is required.");
        const person = await user(request, env);
        const own = await ownPoolIfAvailable(request, env, person);
        const result = await body(await pool(request, env, "switch", {
          user: person, intent: input.intent, id: switching[1], pool: input.pool, ...own?.pool && { own },
        }));
        return json({ computer: computerSummary(result) });
      }
      const refresh = input.computerId !== undefined;
      if (Object.keys(input).some((key) => !["intent", "name", "computerId"].includes(key)) ||
        (refresh ? !text(input.computerId, 512) || !/^[A-Za-z0-9_-]+$/.test(input.computerId) || input.name !== undefined
          : !text(input.name, 60) || !input.name.trim() || /[\u0000-\u001f\u007f]/.test(input.name)))
        throw new SetupError(400, "Choose a computer name of 1 to 60 characters.");
    } else input = { intent: url.searchParams.get("intent") };
    if (!text(input.intent)) throw new SetupError(400, "A setup intent is required.");
    const person = await user(request, env);
    // Revoking needs no pool lookup; listing, minting and refreshing record the person's own pool.
    const selection = await body(await pool(request, env, "validate", { user: person, intent: input.intent }));
    // An intent for the person's own pool already names it; only a shared pool needs the lookup.
    const minting = method === "POST" && input.computerId === undefined;
    const own: OwnPool | undefined = computer ? undefined
      : selection.owner === person && text(selection.pool, 512) && text(selection.organization, 512)
        ? { pool: selection.pool, organization: selection.organization }
        : minting ? await ownPool(request, env, person) : await ownPoolIfAvailable(request, env, person);
    const payload = { ...input, user: person, ...own?.pool && { own } };
    if (method === "POST") {
      if (input.computerId !== undefined) return linkResponse(request, await body(await pool(request, env, "refresh", {
        user: payload.user, intent: input.intent, id: input.computerId,
      })));
      const response = await createLink(request, env, payload, selection, own);
      if (response.ok) emitProductEvent(env.onProductEvent, "setup_started", person);
      return response;
    }
    if (method === "GET") {
      const result = await body(await pool(request, env, "computers", payload));
      if (!Array.isArray(result.computers)) throw new SetupError(502, "Could not list computers.");
      return json({ computers: result.computers.map(computerSummary), pools: poolChoices(result.pools), undoPrompt: undo(url.origin) });
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
