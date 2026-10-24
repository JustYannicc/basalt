import { brand } from "../../brand.ts";
export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// One pool backend user per person per pool. The backend's spend limits apply to every key a user
// owns, so a cap one owner sets must not follow that person into their own pool or anyone else's.
// Names carry digests, never tools-service ids; usage is matched back by digesting known people.

const prefix = `${brand.setup.id}-`;
const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-f]{64})-([0-9a-f]{16})$`);

/** `<setup id>-<sha256(person)>-<first 16 hex of sha256(pool)>`. */
export async function backendUserName(person: string, pool: string): Promise<string> {
  return `${prefix}${await digest(person)}-${(await digest(pool)).slice(0, 16)}`;
}

/** Every backend user of this person starts with this, whichever pool. */
export async function personPrefix(person: string): Promise<string> {
  return `${prefix}${await digest(person)}-`;
}

/** The person and pool digests in a backend user name, or null for any other user. */
export function parseBackendUserName(name: unknown): { person: string; pool: string } | null {
  const match = typeof name === "string" ? pattern.exec(name) : null;
  return match ? { person: match[1]!, pool: match[2]! } : null;
}
