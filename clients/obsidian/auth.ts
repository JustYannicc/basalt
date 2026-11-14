import { endpoint, json, number, object, text, type Http } from "./http.ts";
export interface Session {
  resource: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface Connecting {
  resource: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  deviceCode: string;
  verifier: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  interval: number;
}
const grant = "urn:ietf:params:oauth:grant-type:device_code";
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
export function connectionUrl(input: string, allowLoopback = false) {
  const url = endpoint(input, allowLoopback),
    connection = url.searchParams.get("connection");
  if (
    url.pathname !== "/mcp" ||
    !connection ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(connection) ||
    url.searchParams.getAll("connection").length !== 1
  )
    throw new Error("Use the app-scoped connection link from Signalbox");
  const query = new URLSearchParams({ connection, elicitation_mode: "native" });
  return `${url.origin}/mcp?${query}`;
}
/** What this device says about itself when it asks to connect; Signalbox shows it as its claim. */
export interface DeviceReport {
  /** The device's own name, such as "MacBook Pro". It becomes the device's name in Signalbox. */
  readonly device?: string | undefined;
  /** The vault it connects, which names a vault app still named after the catalog. */
  readonly vault?: string | undefined;
}

export async function beginConnection(
  http: Http,
  input: string,
  now = Date.now(),
  allowLoopback = false,
  report: DeviceReport = {},
): Promise<Connecting> {
  const resource = connectionUrl(input, allowLoopback),
    url = new URL(resource);
  const discovery = object(
    json(
      await http(`${url.origin}/.well-known/oauth-protected-resource/mcp?${url.searchParams}`, {
        method: "GET",
      }),
    ),
  );
  if (
    discovery.resource !== resource ||
    !Array.isArray(discovery.authorization_servers) ||
    typeof discovery.authorization_servers[0] !== "string"
  )
    throw new Error("Signalbox returned discovery for a different connection");
  const issuerValue = discovery.authorization_servers[0],
    issuer = endpoint(issuerValue, allowLoopback);
  const metadata = object(
    json(
      await http(
        `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/u, "")}`,
        { method: "GET" },
      ),
    ),
  );
  if (metadata.issuer !== issuerValue)
    throw new Error("Authorization issuer did not match discovery");
  const approvedEndpoint = (key: string) => {
    const value = endpoint(text(metadata, key), allowLoopback);
    if (value.origin !== issuer.origin) throw new Error("Authorization endpoint changed issuer");
    return value.href;
  };
  const registration = approvedEndpoint("registration_endpoint"),
    device = approvedEndpoint("device_authorization_endpoint"),
    tokenEndpoint = approvedEndpoint("token_endpoint");
  const revocationEndpoint =
    typeof metadata.revocation_endpoint === "string"
      ? approvedEndpoint("revocation_endpoint")
      : null;
  const registered = await http(registration, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: report.device ?? "Signalbox Obsidian Sync",
      token_endpoint_auth_method: "none",
      grant_types: [grant, "refresh_token"],
      response_types: [],
      scope: "mcp offline_access",
    }),
  });
  if (registered.status < 200 || registered.status >= 300)
    throw new Error("Signalbox could not register this device");
  const clientId = text(object(json(registered)), "client_id"),
    verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const reply = await http(
    device,
    form({
      client_id: clientId,
      resource,
      scope: "mcp offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Optional fields: servers that predate them ignore them.
      ...(report.device === undefined ? {} : { device_name: report.device }),
      ...(report.vault === undefined ? {} : { device_context: report.vault }),
    }),
  );
  if (reply.status !== 200) throw new Error("Signalbox could not start device authorization");
  const data = object(json(reply)),
    verificationUrl = endpoint(
      typeof data.verification_uri_complete === "string"
        ? data.verification_uri_complete
        : text(data, "verification_uri"),
      allowLoopback,
    ).href;
  const expires = number(data, "expires_in"),
    interval = typeof data.interval === "number" ? data.interval : 5;
  if (expires <= 0 || expires > 3600 || interval < 1 || interval > 60)
    throw new Error("Invalid device authorization deadline");
  return {
    resource,
    clientId,
    tokenEndpoint,
    revocationEndpoint,
    deviceCode: text(data, "device_code"),
    verifier,
    verificationUrl,
    userCode: text(data, "user_code"),
    expiresAt: now + expires * 1000,
    interval,
  };
}
function token(
  data: Record<string, unknown>,
  prior: {
    resource: string;
    clientId: string;
    tokenEndpoint: string;
    revocationEndpoint: string | null;
    refreshToken?: string;
  },
  now: number,
): Session {
  const expires = number(data, "expires_in");
  if (data.token_type !== "Bearer" && data.token_type !== "bearer")
    throw new Error("Unsupported device token type");
  if (expires <= 0) throw new Error("Expired device token");
  return {
    resource: prior.resource,
    clientId: prior.clientId,
    tokenEndpoint: prior.tokenEndpoint,
    revocationEndpoint: prior.revocationEndpoint,
    accessToken: text(data, "access_token"),
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : (prior.refreshToken ?? ""),
    expiresAt: now + expires * 1000,
  };
}
export async function pollConnection(
  http: Http,
  pending: Connecting,
  now = Date.now(),
): Promise<{ state: "pending"; interval: number } | { state: "connected"; session: Session }> {
  if (now >= pending.expiresAt) throw new Error("Device authorization expired. Connect again.");
  const reply = await http(
      pending.tokenEndpoint,
      form({
        grant_type: grant,
        client_id: pending.clientId,
        device_code: pending.deviceCode,
        code_verifier: pending.verifier,
      }),
    ),
    data = object(json(reply));
  if (reply.status === 200) return { state: "connected", session: token(data, pending, now) };
  if (data.error === "authorization_pending" || data.error === "slow_down")
    return { state: "pending", interval: pending.interval + (data.error === "slow_down" ? 5 : 0) };
  if (data.error === "access_denied") throw new Error("Device authorization was declined");
  throw new Error("Device authorization could not finish. Connect again.");
}
export async function refreshSession(
  http: Http,
  session: Session,
  now = Date.now(),
): Promise<Session> {
  if (!session.refreshToken) throw new Error("Device access expired. Connect again.");
  const reply = await http(
    session.tokenEndpoint,
    form({
      grant_type: "refresh_token",
      client_id: session.clientId,
      refresh_token: session.refreshToken,
      resource: session.resource,
    }),
  );
  if (reply.status !== 200)
    throw new Error("Device access was removed or expired. Reconnect in Signalbox.");
  return token(object(json(reply)), session, now);
}

export async function revokeSession(http: Http, session: Session): Promise<void> {
  if (!session.revocationEndpoint)
    throw new Error("This server requires removing this device in Signalbox Connections.");
  const tokens = [
    ...(session.refreshToken
      ? [{ token: session.refreshToken, token_type_hint: "refresh_token" }]
      : []),
    { token: session.accessToken, token_type_hint: "access_token" },
  ];
  for (const value of tokens) {
    const reply = await http(
      session.revocationEndpoint,
      form({ ...value, client_id: session.clientId }),
    );
    if (reply.status !== 200)
      throw new Error(
        "Device access could not be revoked. Keep this device connected and try again.",
      );
  }
}
