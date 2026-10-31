import { Schema } from "effect";
import { Origin } from "../contracts/connection.ts";
import {
  readClientRegistration,
  readDeviceAuthorization,
  readToken,
  type DeviceCredentials,
} from "../contracts/device.ts";

const grantType = "urn:ietf:params:oauth:grant-type:device_code";
const readFailure = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }));
export class DeviceOAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Native sign-in could not finish.");
    this.code = code;
  }
}
type NativeAuthPath =
  | "/api/auth/oauth2/register"
  | "/api/auth/oauth2/device-authorization"
  | "/api/auth/oauth2/token"
  | "/api/auth/native/access"
  | "/api/auth/native/revoke";
export async function authRequest(
  origin: string,
  path: NativeAuthPath,
  init: RequestInit,
  signal: AbortSignal,
) {
  return globalThis.fetch(new URL(path, origin), {
    ...init,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
}
export async function tokenRequest(
  origin: string,
  fields: Record<string, string>,
  signal: AbortSignal,
) {
  const response = await authRequest(
    origin,
    "/api/auth/oauth2/token",
    {
      method: "POST",
      body: new URLSearchParams(fields),
    },
    signal,
  );
  const value: unknown = await response.json();
  if (!response.ok) throw new DeviceOAuthError(readFailure(value).error);
  const token = readToken(value);
  const scopes = token.scope.split(" ");
  if (
    token.token_type.toLowerCase() !== "bearer" ||
    !scopes.includes("native") ||
    scopes.some((scope) => scope !== "native" && scope !== "offline_access")
  )
    throw new Error("The server returned an incompatible native grant.");
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

/** RFC 8628 pacing is protocol behavior, not a retry of a service operation. */
export interface ProofKeyCrypto {
  randomBytes(): Uint8Array;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
}
const webCrypto: ProofKeyCrypto = {
  randomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
  sha256: async (bytes) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
};
export async function signInDevice(
  originInput: string,
  options: {
    signal: AbortSignal;
    show: (url: string, code: string) => Promise<void>;
    crypto?: ProofKeyCrypto;
  },
): Promise<DeviceCredentials> {
  const origin = Schema.decodeUnknownSync(Origin)(originInput);
  const cryptography = options.crypto ?? webCrypto;
  const verifierBytes = cryptography.randomBytes();
  if (verifierBytes.length !== 32) throw new Error("Invalid proof key entropy.");
  const verifier = base64url(verifierBytes);
  const challenge = base64url(await cryptography.sha256(new TextEncoder().encode(verifier)));
  const registration = await authRequest(
    origin,
    "/api/auth/oauth2/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Signalbox Client",
        token_endpoint_auth_method: "none",
        grant_types: [grantType, "refresh_token"],
        response_types: [],
        scope: "native offline_access",
      }),
    },
    options.signal,
  );
  if (!registration.ok) throw new Error("Native client registration failed.");
  const { client_id } = readClientRegistration(await registration.json());
  const response = await authRequest(
    origin,
    "/api/auth/oauth2/device-authorization",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id,
        scope: "native offline_access",
        resource: `${origin}/native`,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    },
    options.signal,
  );
  if (!response.ok) throw new Error("Native device authorization failed.");
  const request = readDeviceAuthorization(await response.json());
  const verification = new URL(request.verification_uri_complete);
  if (
    request.verification_uri !== `${origin}/native/device` ||
    verification.origin !== origin ||
    verification.pathname !== "/native/device" ||
    verification.hash ||
    verification.searchParams.get("user_code") !== request.user_code ||
    [...verification.searchParams.keys()].some((key) => key !== "user_code")
  )
    throw new Error("The server returned an unexpected approval URL.");
  await options.show(verification.href, request.user_code);
  const deadline = Date.now() + request.expires_in * 1000;
  let interval = Math.max(5, request.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await pause(Math.min(interval, deadline - Date.now()), options.signal);
    if (Date.now() >= deadline) break;
    try {
      const token = await tokenRequest(
        origin,
        {
          grant_type: grantType,
          client_id,
          device_code: request.device_code,
          code_verifier: verifier,
        },
        options.signal,
      );
      return { version: 1, mode: "device", origin, clientId: client_id, ...token };
    } catch (error) {
      if (!(error instanceof DeviceOAuthError)) throw error;
      if (error.code === "slow_down") interval += 5000;
      else if (error.code !== "authorization_pending") throw error;
    }
  }
  throw new DeviceOAuthError("expired_token");
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function pause(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
