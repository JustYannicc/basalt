import type { ConnectionView, CredentialSource } from "../contracts/connection.ts";
import { readDeviceCredentials } from "../contracts/device.ts";
import type { SocketFactory } from "../contracts/transport.ts";
import { deviceConnection } from "../connection/device.ts";
import { signInDevice, type ProofKeyCrypto } from "../connection/device-oauth.ts";
import { connectionHealth } from "../connection/health.ts";

export interface MobileSnapshot {
  phase: "starting" | "signed-out" | "ready" | "storage-error";
  connection?: ConnectionView;
  busy?: string;
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
}
export function mobileController(ports: MobilePorts) {
  let snapshot: MobileSnapshot = { phase: "starting" };
  let source: CredentialSource | undefined;
  let health: ReturnType<typeof connectionHealth> | undefined;
  let initial: Promise<void> | undefined;
  let command: AbortController | undefined;
  let session = new AbortController();
  let foreground = true;
  let resuming = false;
  const listeners = new Set<() => void>();
  const publish = (update: Partial<MobileSnapshot> = {}) => {
    snapshot = { ...snapshot, connection: health?.view() ?? source?.view(), ...update };
    for (const listener of listeners) listener();
  };
  const stopWork = () => {
    session.abort();
    session = new AbortController();
  };
  const attach = (credentials: Parameters<typeof deviceConnection>[0]) => {
    source = deviceConnection(credentials, ports.store, ports.socket);
    health = connectionHealth(source);
  };
  const perform = async (name: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (command || resuming) return;
    command = new AbortController();
    publish({ busy: name, error: undefined });
    try {
      await action(command.signal);
    } catch (error) {
      if (!command.signal.aborted) {
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
        try {
          const raw = await ports.store.read();
          if (!raw) {
            publish({ phase: "signed-out" });
            return;
          }
          attach(readDeviceCredentials(JSON.parse(raw)));
          try {
            await source?.reconnect();
          } catch {}
          publish({ phase: "ready" });
        } catch {
          publish({
            phase: "storage-error",
            error:
              "Saved sign-in could not be opened. Unlock your phone and reconnect, or sign out to remove it.",
          });
        }
      })()),
    signIn: (origin: string) =>
      perform("Sign in", async (signal) => {
        stopWork();
        await health?.close();
        await source?.disconnect();
        try {
          const credentials = await signInDevice(origin, {
            signal,
            crypto: ports.crypto,
            show: async (url, code) => {
              publish({ code });
              // Poll while the browser is open. Its dismissal is not a denial.
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
          publish({ phase: "ready" });
          await source?.reconnect();
        } finally {
          ports.closeApproval();
        }
      }),
    cancel: () => {
      command?.abort();
      ports.closeApproval();
    },
    reconnect: () =>
      perform("Reconnect", async () => {
        stopWork();
        if (!source) {
          const raw = await ports.store.read();
          if (!raw) {
            publish({ phase: "signed-out", error: undefined });
            return;
          }
          attach(readDeviceCredentials(JSON.parse(raw)));
        }
        await source?.reconnect();
        health?.reset();
        publish({ phase: "ready" });
      }),
    disconnect: () =>
      perform("Disconnect", async () => {
        stopWork();
        health?.reset(true);
        await source?.disconnect();
      }),
    signOut: () =>
      perform("Sign out", async () => {
        stopWork();
        await health?.close();
        if (source) await source.signOut();
        else await ports.store.remove();
        source = undefined;
        health = undefined;
        publish({ phase: "signed-out" });
      }),
    revoke: () =>
      perform("Revoke", async () => {
        stopWork();
        await health?.close();
        if (!source) throw new Error("No device is signed in.");
        await source.revoke();
        source = undefined;
        health = undefined;
        publish({ phase: "signed-out" });
      }),
    foreground: async (active: boolean) => {
      foreground = active;
      if (!active) {
        stopWork();
        health?.reset();
        return;
      }
      if (command || resuming || source?.view().state !== "connected") return;
      resuming = true;
      publish({ busy: "Reconnect" });
      try {
        await source.reconnect();
      } catch {
        publish({ error: "The connection needs attention. Reconnect or sign in again." });
      } finally {
        resuming = false;
        publish({ busy: undefined });
      }
    },
    checkHealth: async () => {
      if (foreground && !command && !resuming) {
        await health?.check();
        publish();
      }
    },
    run: async <T>(
      task: (source: CredentialSource, signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => {
      if (!foreground || command || resuming || !source)
        throw new Error("Connect before starting.");
      try {
        return await task(source, AbortSignal.any([session.signal, signal]));
      } finally {
        publish();
      }
    },
  };
}
export type MobileController = ReturnType<typeof mobileController>;
