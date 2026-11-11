import type { ConnectionView, CredentialSource } from "../contracts/connection.ts";
import { readDeviceCredentials } from "../contracts/device.ts";
import type { SocketFactory } from "../contracts/transport.ts";
import { deviceConnection } from "../connection/device.ts";
import { signInDevice, type ProofKeyCrypto } from "../connection/device-oauth.ts";
import { connectionHealth } from "../connection/health.ts";
import { reconnectRecovery } from "./recovery.ts";

export interface MobileSnapshot {
  phase: "starting" | "signed-out" | "ready" | "storage-error";
  connection?: ConnectionView;
  busy?: string;
  reconnecting?: boolean;
  code?: string;
  error?: string;
}
export interface MobilePorts {
  store: {
    read(): Promise<string | undefined>;
    write(value: string): Promise<void>;
    remove(): Promise<void>;
  };
  socket: SocketFactory;
  crypto: ProofKeyCrypto;
  openApproval(url: string): Promise<unknown>;
  closeApproval(): void;
  network?: { subscribe(listener: (online: boolean) => void): () => void };
}
export function mobileController(ports: MobilePorts) {
  let snapshot: MobileSnapshot = { phase: "starting" };
  let source: CredentialSource | undefined;
  let health: ReturnType<typeof connectionHealth> | undefined;
  let initial: Promise<void> | undefined;
  let command: AbortController | undefined;
  let session = new AbortController();
  let foreground = true;
  let automatic = true;
  let unsubscribeNetwork: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (update: Partial<MobileSnapshot> = {}) => {
    snapshot = { ...snapshot, connection: health?.view() ?? source?.view(), ...update };
    for (const listener of listeners) listener();
  };
  const stopWork = () => {
    session.abort();
    session = new AbortController();
  };
  const terminal = () =>
    source?.view().state === "sign-in-required" || source?.view().state === "revoked";
  const recovery = reconnectRecovery({
    allowed: () => foreground && automatic && !command && source !== undefined,
    terminal,
    random: () => Math.random(),
    attempt: async (signal) => {
      stopWork();
      await source?.reconnect(signal);
      health?.reset();
    },
    changed: (reconnecting, error) => publish({ reconnecting, error }),
  });
  const attach = (credentials: Parameters<typeof deviceConnection>[0]) => {
    source = deviceConnection(credentials, ports.store, ports.socket);
    health = connectionHealth(source);
  };
  const perform = async (name: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (command) return;
    const current = new AbortController();
    command = current;
    publish({ busy: name, error: undefined });
    try {
      await recovery.stop();
      publish({ reconnecting: false });
      await action(current.signal);
    } catch {
      if (!current.signal.aborted) {
        // Native storage and network errors can contain request data.
        publish({
          error:
            name === "Revoke"
              ? "Revocation is unconfirmed. Check your account before trying again."
              : "This action could not finish. Check your connection and try again.",
        });
      }
    } finally {
      command = undefined;
      publish({ busy: undefined, code: undefined });
    }
  };
  const networkChanged = (online: boolean) => {
    if (!foreground || !automatic || command || !source || terminal()) return;
    if (online) {
      if (recovery.needed() || source.view().capabilities.length === 0) void recovery.request();
    } else {
      stopWork();
      void recovery.request();
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize: () =>
      (initial ??= (async () => {
        unsubscribeNetwork = ports.network?.subscribe(networkChanged);
        try {
          const raw = await ports.store.read();
          if (!raw) {
            publish({ phase: "signed-out" });
            return;
          }
          attach(readDeviceCredentials(JSON.parse(raw)));
          await recovery.request();
          publish({ phase: "ready" });
        } catch {
          publish({
            phase: "storage-error",
            error:
              "Saved sign-in could not be opened. Unlock your phone and reconnect, or sign out to remove it.",
          });
        }
      })()),
    signIn: async (origin: string) => {
      if (command) return;
      await perform("Sign in", async (signal) => {
        stopWork();
        await health?.close();
        await source?.disconnect();
        source = undefined;
        health = undefined;
        try {
          const credentials = await signInDevice(origin, {
            signal,
            crypto: ports.crypto,
            show: async (url, code) => {
              publish({ code });
              const attempt = command;
              void ports.openApproval(url).catch(() => {
                if (command === attempt) {
                  publish({ error: "The sign-in browser could not open. Try signing in again." });
                  attempt?.abort();
                }
              });
            },
          });
          signal.throwIfAborted();
          await ports.store.write(JSON.stringify(credentials));
          attach(credentials);
          automatic = true;
          publish({ phase: "ready" });
        } finally {
          ports.closeApproval();
        }
      });
      await recovery.request();
    },
    cancel: () => {
      command?.abort();
      ports.closeApproval();
    },
    reconnect: async () => {
      if (command) return;
      await perform("Reconnect", async () => {
        stopWork();
        if (!source) {
          const raw = await ports.store.read();
          if (!raw) {
            publish({ phase: "signed-out", error: undefined });
            return;
          }
          attach(readDeviceCredentials(JSON.parse(raw)));
        }
        automatic = true;
        publish({ phase: "ready" });
      });
      await recovery.request(true);
    },
    disconnect: () =>
      perform("Disconnect", async () => {
        automatic = false;
        stopWork();
        health?.reset(true);
        await source?.disconnect();
        publish({ reconnecting: false });
      }),
    signOut: () =>
      perform("Sign out", async () => {
        automatic = false;
        stopWork();
        await health?.close();
        if (source) await source.signOut();
        else await ports.store.remove();
        source = undefined;
        health = undefined;
        publish({ phase: "signed-out", reconnecting: false });
      }),
    revoke: () =>
      perform("Revoke", async () => {
        stopWork();
        await health?.close();
        if (!source) throw new Error("No device is signed in.");
        await source.revoke();
        automatic = false;
        source = undefined;
        health = undefined;
        publish({ phase: "signed-out", reconnecting: false });
      }),
    foreground: async (active: boolean) => {
      foreground = active;
      if (!active) {
        stopWork();
        await recovery.stop();
        health?.reset();
        return;
      }
      await recovery.request();
    },
    checkHealth: async () => {
      if (!foreground || command || recovery.running()) return;
      const before = health?.view().health?.state;
      await health?.check();
      publish();
      const after = health?.view().health?.state;
      if (
        (after === "online" && (before === "offline" || recovery.needed())) ||
        (after === "offline" && !recovery.needed())
      )
        await recovery.request();
    },
    run: async <T>(
      task: (source: CredentialSource, signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => {
      if (!foreground || command || recovery.needed() || !source)
        throw new Error("Connect before starting.");
      try {
        return await task(source, AbortSignal.any([session.signal, signal]));
      } finally {
        publish();
        if (source.view().state === "connected" && source.view().capabilities.length === 0)
          void recovery.request();
      }
    },
    close: async () => {
      foreground = false;
      unsubscribeNetwork?.();
      stopWork();
      await recovery.stop();
      await health?.close();
    },
  };
}
export type MobileController = ReturnType<typeof mobileController>;
