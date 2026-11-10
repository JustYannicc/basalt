import { newDeviceId } from "./store.ts";
import type { BinaryClient } from "./binary-types.ts";
import {
  beginConnection,
  pollConnection,
  revokeSession,
  connectionUrl,
  type Connecting,
  type Session,
} from "./auth.ts";
import { createRemote } from "./remote.ts";
import { createSync } from "./sync.ts";
import { object, text, number, type Http } from "./http.ts";
import { maximumFileBytes, type LocalVault, type StateStore, type SyncStatus } from "./types.ts";
export interface DeviceConfig {
  connection: string;
  appId: string;
  appSlug: string;
}
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
export interface DeviceStatus {
  initial?: SyncStatus["initial"];
  state: SyncStatus["state"] | "disconnected" | "authorizing" | "paused";
  queued: number;
  conflicts: number;
  unsupported: readonly string[];
  error: string | null;
  head: string | null;
  importId: string | null;
}
const config = (input: unknown): DeviceConfig => {
  const value = object(input),
    appId = text(value, "appId"),
    appSlug = text(value, "appSlug");
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(appId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(appSlug))
    throw new Error("Invalid Basalt app identity");
  return { connection: connectionUrl(text(value, "connection")), appId, appSlug };
};
const credential = (input: string) => {
  if (input.length > 128 * 1024) throw new Error("Saved device credential is invalid");
  return object(JSON.parse(input));
};
function session(input: unknown): Session {
  const value = object(input);
  return {
    resource: connectionUrl(text(value, "resource")),
    clientId: text(value, "clientId"),
    tokenEndpoint: text(value, "tokenEndpoint"),
    revocationEndpoint:
      value.revocationEndpoint === null ? null : text(value, "revocationEndpoint"),
    accessToken: text(value, "accessToken"),
    refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : "",
    expiresAt: number(value, "expiresAt"),
  };
}
function connecting(input: unknown): Connecting {
  const value = object(input);
  return {
    resource: connectionUrl(text(value, "resource")),
    clientId: text(value, "clientId"),
    tokenEndpoint: text(value, "tokenEndpoint"),
    revocationEndpoint:
      value.revocationEndpoint === null ? null : text(value, "revocationEndpoint"),
    deviceCode: text(value, "deviceCode"),
    verifier: text(value, "verifier"),
    verificationUrl: text(value, "verificationUrl"),
    userCode: text(value, "userCode"),
    expiresAt: number(value, "expiresAt"),
    interval: number(value, "interval"),
  };
}
export async function createController(input: {
  http: Http;
  local: LocalVault;
  states: (appId: string) => StateStore;
  secrets: SecretStore;
  key: string;
  changed: () => void;
  binary?: (input: {
    appId: string;
    remote: ReturnType<typeof createRemote>;
    signal: AbortSignal;
    resolve: (ref: string, edits: readonly import("./types.ts").Edit[]) => Promise<void>;
  }) => Promise<BinaryClient>;
}) {
  const { http, local, secrets, key, changed } = input;
  if (!/^[a-z0-9-]+$/u.test(key)) throw new Error("Invalid device secret storage key");
  let current: { config: DeviceConfig; session: Session; paused: boolean } | null = null;
  let pending: { config: DeviceConfig; request: Connecting; previousPaused: boolean } | null = null;
  const saved = secrets.get(key),
    pairing = secrets.get(key + "-pending");
  if (saved) {
    const data = credential(saved);
    current = {
      config: config(data.config),
      session: session(data.session),
      paused: data.paused === true,
    };
  }
  if (pairing) {
    const data = credential(pairing);
    pending = {
      config: config(data.config),
      request: connecting(data.request),
      previousPaused: data.previousPaused === true,
    };
  }
  let driveAbort = new AbortController();
  let binary: BinaryClient | null = null;
  let remote: ReturnType<typeof createRemote> | null = null,
    client: Awaited<ReturnType<typeof createSync>> | null = null,
    active: Promise<void> | null = null,
    closed = false;
  const retain = () => {
    if (current) secrets.set(key, JSON.stringify(current));
  };
  const open = async () => {
    if (!current) return;
    if (current.session.resource !== current.config.connection)
      throw new Error("Saved device grant belongs to another connection");
    binary?.close();
    driveAbort = new AbortController();
    remote = createRemote({
      http,
      session: current.session,
      appSlug: current.config.appSlug,
      appId: current.config.appId,
      saveSession: async (value) => {
        if (current) {
          current.session = value;
          retain();
        }
      },
    });
    binary = input.binary
      ? await input.binary({
          appId: current.config.appId,
          remote,
          signal: driveAbort.signal,
          resolve: async (ref, edits) => {
            if (!client || current?.paused) throw new Error("Resume sync first");
            await client.resolve(ref, edits);
            changed();
          },
        })
      : null;
    client = await createSync({
      local: binary?.local ?? local,
      remote,
      store: input.states(current.config.appId),
      id: newDeviceId,
      signal: driveAbort.signal,
    });
  };
  await open();
  const status = (): DeviceStatus => {
    const base = client?.status() ?? {
      state: "idle",
      queued: 0,
      conflicts: 0,
      unsupported: [],
      error: null,
      head: null,
      importId: null,
    };
    return {
      ...base,
      state: pending
        ? "authorizing"
        : !current
          ? "disconnected"
          : current.paused
            ? "paused"
            : active
              ? "syncing"
              : base.state,
    };
  };
  const run = (fetchOnly: boolean) => {
    if (closed || pending || !current || current.paused || !client) return Promise.resolve();
    if (active) return active;
    const work = (async () => {
      if (driveAbort.signal.aborted) {
        await remote?.close();
        await open();
      }
      await (fetchOnly ? client?.pull() : client?.run());
      await binary?.flush();
    })();
    changed();
    active = work.finally(() => {
      active = null;
      changed();
    });
    return active;
  };
  return {
    status,
    config: () => current?.config ?? pending?.config ?? null,
    attachments: () => binary,
    authorization: () =>
      pending
        ? {
            url: pending.request.verificationUrl,
            code: pending.request.userCode,
            expiresAt: pending.request.expiresAt,
            interval: pending.request.interval,
          }
        : null,
    async begin(value: DeviceConfig) {
      const selected = config(value),
        previousPaused = current?.paused ?? false;
      if (current) {
        current.paused = true;
        retain();
      }
      driveAbort.abort();
      await active?.catch(() => {});
      try {
        const request = await beginConnection(http, selected.connection);
        pending = { config: selected, request, previousPaused };
        secrets.set(key + "-pending", JSON.stringify(pending));
        changed();
        return {
          url: request.verificationUrl,
          code: request.userCode,
          interval: request.interval,
          expiresAt: request.expiresAt,
        };
      } catch (failure) {
        if (current) {
          current.paused = previousPaused;
          retain();
        }
        changed();
        throw failure;
      }
    },
    async poll() {
      if (!pending) return false;
      const result = await pollConnection(http, pending.request);
      if (result.state === "pending") {
        pending.request.interval = result.interval;
        secrets.set(key + "-pending", JSON.stringify(pending));
        return false;
      }
      await remote?.close();
      current = { config: pending.config, session: result.session, paused: false };
      retain();
      pending = null;
      secrets.set(key + "-pending", "");
      await open();
      changed();
      return true;
    },
    cancel() {
      if (current && pending) {
        current.paused = pending.previousPaused;
        retain();
      }
      pending = null;
      secrets.set(key + "-pending", "");
      changed();
    },
    /** A checkpoint: commits and pushes every local change, then pulls. */
    sync: () => run(false),
    /** Brings cloud changes down without committing anything. */
    pull: () => run(true),
    async pause(value: boolean) {
      if (current) {
        current.paused = value;
        retain();
      }
      if (value) {
        driveAbort.abort();
        await active?.catch(() => {});
      } else if (driveAbort.signal.aborted) {
        await remote?.close();
        await open();
      }
      changed();
    },
    async disconnect() {
      if (!current) return;
      current.paused = true;
      retain();
      driveAbort.abort();
      changed();
      await active?.catch(() => {});
      await remote?.close();
      await revokeSession(http, current.session);
      secrets.set(key, "");
      secrets.set(key + "-pending", "");
      current = null;
      pending = null;
      client = null;
      binary?.close();
      binary = null;
      remote = null;
      changed();
    },
    conflicts: () => client?.conflicts() ?? [],
    async version(path: string, at: string) {
      if (!remote) throw new Error("Connect this device first");
      let content = "",
        offset = 0;
      for (;;) {
        const page = await remote.read({ path, at, offset, maxBytes: 8192 });
        if (!page) return null;
        if (page.bytes > maximumFileBytes)
          throw new Error("This note exceeds the device file limit");
        content += page.content;
        if (page.next === null) return content;
        if (page.next <= offset) throw new Error("Cloud read did not advance");
        offset = page.next;
      }
    },
    async resolve(ref: string, edits: readonly { path: string; content: string | null }[]) {
      if (!client || current?.paused) throw new Error("Resume sync first");
      await client.resolve(ref, edits);
      changed();
    },
    async close() {
      closed = true;
      driveAbort.abort();
      binary?.close();
      await active?.catch(() => {});
      await remote?.close();
    },
  };
}
export type DeviceController = Awaited<ReturnType<typeof createController>>;
