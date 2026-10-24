import { brand } from "../../brand.ts";
import { digest, randomSecret } from "./computer-home.ts";
import { fail, object } from "./json.ts";
import type { PoolClaims } from "./token.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

export const setupTtl = 5 * 60_000;
export const intentPrefix = "sbci1";
export interface SetupIntent extends PoolClaims { user: string; expiresAt: number }
export interface Credentials { modelUrl: string; modelKey: string; toolsUrl: string; toolsToken: string }
export interface SealedLink { hash: string; expiresAt: number; iv: number[]; bytes: number[] }

export async function readIntent(key: string, opaque: unknown, user: string, now: number, previous?: string): Promise<SetupIntent> {
  const value = typeof opaque === "string" ? await openEnvelope(key, intentPrefix, opaque, previous) : undefined;
  if (!object(value) || value.user !== user || typeof value.pool !== "string" || !value.pool
    || typeof value.owner !== "string" || !value.owner || typeof value.organization !== "string" || !value.organization
    || typeof value.expiresAt !== "number" || value.expiresAt <= now || value.expiresAt > now + setupTtl)
    return fail(401, "unauthorized", "Open setup again from your pool. This setup session has expired.");
  if (value.owner !== user) return fail(403, "not_owner", "Set up this computer with your own pool. Shared pools come with pool sharing.");
  return value as unknown as SetupIntent;
}

async function cipherKey(secret: string, usage: KeyUsage) {
  // Domain separation keeps setup ciphertext independent of pool token signatures.
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`computer-setup:${secret}`));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, [usage]);
}
export async function seal(secret: string, credentials: Credentials, now: number): Promise<{ token: string; link: SealedLink }> {
  const token = randomSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cipherKey(secret, "encrypt"),
    new TextEncoder().encode(JSON.stringify(credentials)));
  return { token, link: { hash: await digest(token), expiresAt: now + setupTtl, iv: [...iv], bytes: [...new Uint8Array(bytes)] } };
}
export async function unseal(secret: string, link: SealedLink, previous?: string): Promise<Credentials> {
  try {
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(link.iv) },
      await cipherKey(secret, "decrypt"), new Uint8Array(link.bytes));
    return JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    if (previous) return unseal(previous, link);
    throw error;
  }
}
export function setupInstructions(origin: string): string {
  return `Set up this computer for ${brand.name}. Pasting the setup prompt already authorizes these changes. Run the installer without another confirmation.\n\n` +
    `Download ${origin}/setup/client.mjs to a private temporary file, then run it with Node.js 18 or newer and --link followed by this one-time link. The installer reads the response as JSON, backs up every config file before writing, and writes only model gateway settings and the ${brand.mcpServerName} MCP entry. Keep credentials out of chat, logs and source files. Delete the temporary installer afterwards.\n\n` +
    `For Claude Code it sets the base URL and token, gateway model discovery and timeouts. It preserves permissions, telemetry, model and effort. Codex keeps other providers and uses requires_openai_auth = true with the model key in X-Api-Key. Sign Codex into any ChatGPT account; account-side features follow that account's plan. The Claude desktop app is not covered.\n\n` +
    `When the installer succeeds, say setup is done. Tell the person to restart Claude Code or Codex, send a message, and ask for a tool search through ${brand.mcpServerName}. The computer turns green only after a successful model request and tool call. Undo is a separate paste using the same installer with --undo; it restores the backups and preserves later unrelated edits. Revoking the computer in the pool stops both credentials.\n`;
}
export const signIntent = (secret: string, intent: SetupIntent) => signEnvelope(secret, intentPrefix, intent);
