import { brand } from "../../brand.ts";
import { digest, randomSecret } from "./computer-home.ts";
import { fail, object } from "./json.ts";
import type { PoolClaims } from "./token.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

export const setupTtl = 5 * 60_000;
/** A person's own label for a computer: 1 to 60 characters after trimming, without control characters. */
export function computerName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}
export const intentPrefix = "sbci1";
export interface SetupIntent extends PoolClaims { user: string; expiresAt: number }
/** The tools pair is absent for a models-only computer. */
export interface Credentials { modelUrl: string; modelKey: string; toolsUrl?: string; toolsToken?: string }
export interface SealedLink { hash: string; expiresAt: number; iv: number[]; bytes: number[] }

export async function readIntent(key: string, opaque: unknown, user: string, now: number, previous?: string): Promise<SetupIntent> {
  const value = typeof opaque === "string" ? await openEnvelope(key, intentPrefix, opaque, previous) : undefined;
  if (!object(value) || value.user !== user || typeof value.pool !== "string" || !value.pool
    || typeof value.owner !== "string" || !value.owner || typeof value.organization !== "string" || !value.organization
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + setupTtl)
    return fail(401, "unauthorized", "Open setup again from your pool. This setup session has expired.");
  return value as unknown as SetupIntent;
}

async function cipherKey(secret: string, usage: "encrypt" | "decrypt") {
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
/** What an agent reads if it opens the link itself instead of running the installer. */
export function setupInstructions(origin: string): string {
  return `Set up ${brand.name} on this computer; the person already approved it. Run ${origin}/setup/client.mjs with Node.js 18 or newer, then tell them what it changed.\n`;
}
export const signIntent = (secret: string, intent: SetupIntent) => signEnvelope(secret, intentPrefix, intent);
