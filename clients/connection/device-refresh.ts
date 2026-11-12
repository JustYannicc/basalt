import type { DeviceCredentials } from "../contracts/device.ts";
import { untilAborted } from "./abort.ts";
import { DeviceOAuthError, tokenRequest } from "./device-oauth.ts";

export class RefreshReplayBudgetError extends Error {}
export class RefreshRefusedError extends Error {}

export async function refreshDeviceCredentials(
  current: DeviceCredentials,
  signal: AbortSignal,
  commit: (next: DeviceCredentials) => Promise<void>,
) {
  // The server durably replays the same pair for an hour. Keep client replay well inside it.
  const unknown = current.refreshPending === true;
  const startedAt = unknown ? (current.refreshStartedAt ?? Date.now()) : Date.now();
  if (unknown && Date.now() - startedAt >= 600_000)
    throw new RefreshReplayBudgetError("Refresh replay time limit reached.");
  await commit({ ...current, refreshPending: true, refreshStartedAt: startedAt });
  const tokens = await tokenRequest(
    current.origin,
    {
      grant_type: "refresh_token",
      resource: `${current.origin}/native`,
      client_id: current.clientId,
      refresh_token: current.refreshToken,
    },
    signal,
  ).catch(async (error: unknown) => {
    if (
      error instanceof DeviceOAuthError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    )
      throw new RefreshRefusedError("Native sign-in was refused.");
    if (
      !unknown &&
      error instanceof Error &&
      error.message === "fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT"
    )
      await commit({ ...current, refreshPending: "not-sent" });
    throw error;
  });
  const next = { ...current, ...tokens, refreshPending: false };
  delete next.refreshStartedAt;
  await commit(next);
}

/** Validation may restart while rotation keeps ownership of its response and durable write. */
export function deviceRefresh(ports: {
  store: { write(value: string): Promise<void> };
  changed(credentials: DeviceCredentials): void;
  unavailable(state: "sign-in-required" | "disconnected"): void;
}) {
  let pending: Promise<void> | undefined;
  let generation = 0;
  let lifetime = new AbortController();
  return {
    start(current: DeviceCredentials) {
      if (pending) return pending;
      const ownGeneration = generation;
      const deadline = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(new Error("Refresh timed out.")), 30_000);
      const check = () => {
        signal.throwIfAborted();
        if (ownGeneration !== generation) throw new Error("Connection state changed.");
      };
      const active = untilAborted(
        refreshDeviceCredentials(current, signal, async (next) => {
          check();
          await ports.store.write(JSON.stringify(next));
          check();
          ports.changed(next);
        }),
        signal,
      )
        .catch((error: unknown) => {
          if (ownGeneration === generation) {
            if (error instanceof RefreshRefusedError) ports.unavailable("sign-in-required");
            else if (error instanceof RefreshReplayBudgetError) ports.unavailable("disconnected");
          }
          throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          if (pending === active) pending = undefined;
        });
      pending = active;
      return active;
    },
    wait: (signal = new AbortController().signal) =>
      untilAborted(pending ?? Promise.resolve(), signal),
    stop: () => {
      generation++;
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
