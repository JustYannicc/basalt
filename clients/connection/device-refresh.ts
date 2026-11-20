import type { DeviceCredentials } from "../contracts/device.ts";
import { nativeTunnelReadyTimeoutMs } from "../contracts/tunnel.ts";
import { untilAborted } from "./abort.ts";
import { DeviceOAuthError, tokenRequest } from "./device-oauth.ts";

/**
 * How long the server answers a rotated refresh token with the pair it already issued: its
 * refresh-token reuse interval, which it sets to the access-token lifetime and counts from the
 * rotation. A first attempt starts no later than that rotation, so a replay younger than this is
 * still answered. An older one can be refused as token reuse, so the client asks for sign-in
 * instead of sending it. The answer carries only what is left of the pair's first lifetime, so
 * replay stops while that still covers what a token needs before use.
 */
const refreshReplayLimitMs = 3_600_000 - nativeTunnelReadyTimeoutMs;

/** The saved grant can no longer be renewed. Only a fresh sign-in recovers. */
class RefreshSignInRequiredError extends Error {}

export async function refreshDeviceCredentials(
  current: DeviceCredentials,
  signal: AbortSignal,
  commit: (next: DeviceCredentials) => Promise<void>,
) {
  const unknown = current.refreshPending === true;
  const startedAt = unknown ? (current.refreshStartedAt ?? Date.now()) : Date.now();
  // The start is saved, so sleep, a restart and Reconnect all measure the same elapsed time.
  if (unknown && Date.now() - startedAt >= refreshReplayLimitMs)
    throw new RefreshSignInRequiredError("The server no longer replays this refresh.");
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
      error.code === "invalid_grant" &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    )
      throw new RefreshSignInRequiredError("Native sign-in was refused.");
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
  signInRequired(): void;
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
          if (ownGeneration === generation && error instanceof RefreshSignInRequiredError)
            ports.signInRequired();
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
