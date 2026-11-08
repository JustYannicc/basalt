import { connectionUrl } from "./auth.ts";
import type { DeviceConfig } from "./controller.ts";

/** `obsidian://basalt-sync?...` is the only way a vault gets connected. */
export const protocolAction = "basalt-sync";

export interface ConnectRequest {
  config: DeviceConfig;
  /** The vault the link was made for, when Basalt knew it. */
  vaultName: string | null;
  /** Shown to the person before anything is sent, so a stray link can't quietly pick the server. */
  host: string;
}

const identity = /^[A-Za-z0-9_-]{1,128}$/u;

const field = (params: Readonly<Record<string, string>>, key: string) => {
  const value = params[key];
  return typeof value === "string" && value.length > 0 && value !== "true" ? value : null;
};

/** Parses protocol handler params. Throws a person-readable message on anything malformed. */
export function parseConnectLink(params: Readonly<Record<string, string>>): ConnectRequest {
  const connection = field(params, "connection"),
    appId = field(params, "appId"),
    appSlug = field(params, "appSlug");
  if (!connection || !appId || !appSlug)
    throw new Error("This Basalt link is incomplete. Open Connect Obsidian in Basalt again.");
  if (!identity.test(appId) || !identity.test(appSlug))
    throw new Error(
      "This Basalt link names an invalid app. Open Connect Obsidian in Basalt again.",
    );
  // connectionUrl enforces HTTPS, the /mcp path and exactly one scoped connection id.
  const scoped = connectionUrl(connection);
  const vaultName = field(params, "vaultName") ?? field(params, "vault");
  return {
    config: { connection: scoped, appId, appSlug },
    vaultName: vaultName && vaultName.length <= 255 ? vaultName : null,
    host: new URL(scoped).host,
  };
}

/**
 * Builds the link Basalt opens after it creates the app-scoped MCP connection.
 * Every parameter is non-secret; the grant itself happens through device authorization.
 * Obsidian routes `vault=` to that vault's window, so it is only set when Basalt knows the name.
 */
export function buildConnectLink(input: DeviceConfig & { vaultName?: string }): string {
  const scoped = connectionUrl(input.connection);
  if (!identity.test(input.appId) || !identity.test(input.appSlug))
    throw new Error("Invalid Basalt app identity");
  const query = new URLSearchParams();
  if (input.vaultName) query.set("vault", input.vaultName);
  query.set("connection", scoped);
  query.set("appId", input.appId);
  query.set("appSlug", input.appSlug);
  // URLSearchParams writes spaces as `+`, which plain percent-decoding keeps literal.
  return `obsidian://${protocolAction}?${query.toString().replace(/\+/gu, "%20")}`;
}
