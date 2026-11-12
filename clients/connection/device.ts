import { Schema } from "effect";
import type {
  AppSummary,
  Capability,
  ConnectionView,
  CredentialSource,
} from "../contracts/connection.ts";
import {
  readDeviceCredentials,
  readNativeAccess,
  type DeviceCredentials,
  type NativeAccess,
} from "../contracts/device.ts";
import { tunnelPath, nativeTunnelReadyTimeoutMs } from "../contracts/tunnel.ts";
import { authRequest } from "./device-oauth.ts";
import { refreshDeviceCredentials } from "./device-refresh.ts";
import { nativeAccess } from "./native-access.ts";
import { untilAborted } from "./abort.ts";
import { orderedDeviceStore } from "./device-store.ts";
import { openTunnel } from "./tunnel.ts";
import type { SocketFactory } from "../contracts/transport.ts";

/** The inventory fields the summary needs; other fields are ignored. */
const Inventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String })),
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  appLinks: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  accountCounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ app: Schema.String, count: Schema.Int })),
  ),
});
const readInventory = Schema.decodeUnknownSync(Inventory);

export function deviceConnection(
  initial: DeviceCredentials,
  storage: {
    read(): Promise<string | undefined>;
    write(value: string): Promise<void>;
    remove(): Promise<void>;
  },
  socket: SocketFactory,
  onRetryAfter?: (timestamp: number) => void,
): CredentialSource {
  const store = orderedDeviceStore(storage);
  let saved: DeviceCredentials | undefined = initial;
  let access: NativeAccess | undefined;
  let display: NativeAccess["display"];
  let state: ConnectionView["state"] = "connected";
  let pending: Promise<void> | undefined;
  let validation: Promise<void> | undefined;
  let validationAbort = new AbortController();
  let epoch = 0;
  const capabilities = (): Capability[] =>
    access
      ? [
          ...(access.policy.models ? ["models" as const] : []),
          ...(access.policy.toolsOrganization ? ["tools" as const] : []),
        ]
      : [];
  const checkCurrent = (generation: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (generation !== epoch) throw new Error("Connection state changed.");
  };
  const renew = (current: DeviceCredentials, signal: AbortSignal, generation: number) =>
    refreshDeviceCredentials(current, signal, async (next) => {
      checkCurrent(generation, signal);
      await store.write(JSON.stringify(next));
      checkCurrent(generation, signal);
      saved = next;
    });
  const readAccess = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = saved;
    if (state !== "connected") throw new Error("The connection is not connected.");
    if (!current || (current.refreshPending === true && !pending)) {
      state = "sign-in-required";
      throw new Error("Sign in again before using this device.");
    }
    const generation = epoch;
    try {
      const bearer = async () => {
        const credential = saved;
        if (
          !credential ||
          (credential.refreshPending === true && !pending) ||
          generation !== epoch ||
          state !== "connected"
        )
          throw new Error("Connection state changed.");
        if (!pending && credential.expiresAt <= Date.now() + nativeTunnelReadyTimeoutMs) {
          const renewal = untilAborted(renew(credential, signal, generation), signal).finally(
            () => {
              if (pending === renewal) pending = undefined;
            },
          );
          pending = renewal;
        }
        await pending;
        signal.throwIfAborted();
        if (generation !== epoch || state !== "connected" || !saved)
          throw new Error("Connection state changed.");
        return saved.accessToken;
      };
      const response = await nativeAccess(current.origin, bearer, signal, onRetryAfter);
      checkCurrent(generation, signal);
      const next = saved;
      if (!next || generation !== epoch) throw new Error("Connection state changed.");
      if (!response.ok) {
        if (generation === epoch && (response.status === 401 || response.status === 403))
          state = "sign-in-required";
        await response.body?.cancel();
        throw new Error("Native access is unavailable.");
      }
      const checked = readNativeAccess(await response.json());
      checkCurrent(generation, signal);
      if (
        checked.clientId !== next.clientId ||
        checked.expiresAt <= Date.now() ||
        (!checked.policy.models && checked.policy.toolsOrganization === undefined)
      )
        throw new Error("Native access is incompatible.");
      if (generation !== epoch) throw new Error("Connection state changed.");
      access = checked;
      display = checked.display;
    } catch (error) {
      if (generation === epoch) {
        if (state === "connected" && saved?.refreshPending === true && !pending)
          state = "sign-in-required";
        if (!signal.aborted || state !== "connected") access = undefined;
      }
      throw error;
    }
  };
  const validate = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (state !== "connected") throw new Error("The connection is not connected.");
    if (
      access &&
      saved &&
      Math.min(access.expiresAt, saved.expiresAt) > Date.now() + nativeTunnelReadyTimeoutMs
    )
      return;
    // A cancelled caller must not cancel the grant refresh shared by sibling operations.
    if (!validation) {
      const active = untilAborted(
        readAccess(validationAbort.signal),
        validationAbort.signal,
      ).finally(() => {
        if (validation === active) validation = undefined;
      });
      validation = active;
    }
    await untilAborted(validation, signal);
  };
  const clearAccess = () => {
    access = undefined;
    validationAbort.abort();
    validationAbort = new AbortController();
  };
  const authorize = async (signal: AbortSignal) => {
    await validate(signal);
    signal.throwIfAborted();
    if (state !== "connected" || !saved || !access)
      throw new Error("The connection is unavailable.");
    return saved;
  };
  return {
    origins: () => (saved ? [saved.origin] : []),
    view: () => ({
      state,
      mode: "device",
      capabilities: state === "connected" ? capabilities() : [],
      ...(display ? { display } : {}),
      ...(saved ? { origin: saved.origin } : {}),
    }),
    // The panel uses the same cached grant as agents: closing it can't cancel a shared refresh,
    // and a failed list never changes connection state.
    apps: async (signal): Promise<AppSummary | undefined> => {
      const generation = epoch;
      const current = await authorize(signal);
      const organization = access?.policy.toolsOrganization;
      if (organization === undefined) return undefined;
      const response = await globalThis.fetch(
        new URL(`/api/organizations/${encodeURIComponent(organization)}/inventory`, current.origin),
        {
          headers: { authorization: `Bearer ${current.accessToken}` },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("The app list is unavailable.");
      }
      const inventory = readInventory(await response.json());
      // A sign-out or disconnect during the read leaves nothing for the panel to show.
      if (generation !== epoch || current !== saved) throw new Error("Connection state changed.");
      const counts = new Map(inventory.accountCounts?.map(({ app, count }) => [app, count]));
      // Without server counts, only the caller's own links are known.
      const linked = new Map<string, Set<string>>();
      for (const link of [...inventory.links, ...inventory.appLinks])
        linked.set(link.app, (linked.get(link.app) ?? new Set()).add(link.account));
      return {
        organization,
        apps: inventory.apps.map((app) => ({
          id: app.id,
          name: app.name,
          accounts: counts.get(app.id) ?? linked.get(app.id)?.size ?? 0,
        })),
      };
    },
    transport: async (signal) => {
      const current = await authorize(signal);
      return {
        mode: "device",
        capabilities: capabilities(),
        open: (request, operationSignal) => {
          if (state !== "connected" || current !== saved)
            throw new Error("Connection state changed.");
          const url = new URL(tunnelPath, current.origin);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          return openTunnel(socket(url.href, current.accessToken), request, operationSignal, () => {
            access = undefined;
          });
        },
      };
    },
    disconnect: async () => {
      epoch++;
      state = "disconnected";
      clearAccess();
      await validation?.catch(() => undefined);
      await pending?.catch(() => undefined);
    },
    reconnect: async (signal = new AbortController().signal) => {
      const generation = ++epoch;
      clearAccess();
      const activeSignal = AbortSignal.any([signal, validationAbort.signal]);
      const cancel = () => {
        if (generation !== epoch) return;
        epoch++;
        access = undefined;
        // A cancelled rotating exchange can have succeeded remotely. Never replay it.
        if (saved?.refreshPending === true) state = "sign-in-required";
      };
      activeSignal.addEventListener("abort", cancel, { once: true });
      try {
        activeSignal.throwIfAborted();
        await untilAborted(validation?.catch(() => undefined) ?? Promise.resolve(), activeSignal);
        await untilAborted(pending?.catch(() => undefined) ?? Promise.resolve(), activeSignal);
        const raw = await untilAborted(store.read(), activeSignal);
        checkCurrent(generation, activeSignal);
        saved = raw === undefined ? undefined : readDeviceCredentials(JSON.parse(raw));
        state = "connected";
        const active = untilAborted(readAccess(activeSignal), activeSignal).finally(() => {
          if (validation === active) validation = undefined;
        });
        validation = active;
        await active;
      } finally {
        activeSignal.removeEventListener("abort", cancel);
      }
    },
    signOut: async () => {
      epoch++;
      state = "sign-in-required";
      clearAccess();
      await validation?.catch(() => undefined);
      display = undefined;
      await pending?.catch(() => undefined);
      saved = undefined;
      await store.remove();
    },
    revoke: async () => {
      const current = await authorize(new AbortController().signal);
      const response = await authRequest(
        current.origin,
        "/api/auth/native/revoke",
        {
          method: "POST",
          headers: { authorization: `Bearer ${current.accessToken}` },
        },
        new AbortController().signal,
      );
      if (!response.ok)
        throw new Error("Device revocation is unconfirmed. Check your account before retrying.");
      epoch++;
      state = "revoked";
      clearAccess();
      display = undefined;
      saved = undefined;
      await store.remove();
    },
  };
}
