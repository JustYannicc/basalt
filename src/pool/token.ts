// A pool token lets one pool app instance manage one pool, and nothing else.
// The tools service signs it when it installs a person's pool. The pool Worker
// verifies it. The pool backend's management key never leaves the pool Worker.
// This file imports nothing: the bundler copies it into the tools service as is.

export interface PoolClaims {
  /** The pool app's id. One pool is one app instance. */
  readonly pool: string;
  /** The tools-service user who owns the pool. */
  readonly owner: string;
  /** The organization the pool app lives in. */
  readonly organization: string;
}

const poolPrefix = "sbp1";
const encoder = new TextEncoder();

export function isSigningKey(secret: string): boolean {
  return /^[0-9a-f]{64}$/.test(secret);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Only the canonical encoding decodes, so one payload has exactly one signed form. */
function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return base64url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function signingKey(secret: string, usage: "sign" | "verify") {
  if (!isSigningKey(secret)) throw new Error("Pool signing key must be 32 bytes of hex");
  const raw = Uint8Array.from(secret.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `prefix.payload.signature`, the payload being base64url JSON. Prefixes keep kinds apart. */
export async function signEnvelope(secret: string, prefix: string, value: unknown): Promise<string> {
  const signed = `${prefix}.${base64url(encoder.encode(JSON.stringify(value)))}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret, "sign"), encoder.encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/** The payload of a validly signed envelope of this kind, or undefined for anything else. */
export async function openEnvelope(secret: string, prefix: string, envelope: string): Promise<unknown> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return undefined;
  const signature = fromBase64url(parts[2]!);
  const payload = fromBase64url(parts[1]!);
  if (!signature || !payload) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC", await signingKey(secret, "verify"), signature, encoder.encode(`${prefix}.${parts[1]}`),
  );
  if (!valid) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}

function validClaims(value: unknown): value is PoolClaims {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return ["pool", "owner", "organization"].every(
    (key) => typeof claims[key] === "string" && (claims[key] as string).length > 0,
  );
}

export async function signPoolToken(secret: string, claims: PoolClaims): Promise<string> {
  if (!validClaims(claims)) throw new Error("Pool claims are incomplete");
  return signEnvelope(secret, poolPrefix, {
    pool: claims.pool, owner: claims.owner, organization: claims.organization,
  });
}

/** Returns the claims of a valid token, or undefined for anything else. */
export async function verifyPoolToken(secret: string, token: string): Promise<PoolClaims | undefined> {
  const claims = await openEnvelope(secret, poolPrefix, token);
  return validClaims(claims) ? claims : undefined;
}
