import type { DeviceCredentials } from "../contracts/device.ts";
import { untilAborted } from "./abort.ts";
import { DeviceOAuthError, tokenRequest } from "./device-oauth.ts";

/** The server refused the saved grant. Only a fresh sign-in recovers. */
class RefreshSignInRequiredError extends Error {}

/**
 * Token refusals a fresh sign-in fixes: it registers a new client and grants scope and resource
 * again. With no time limit, any of these would otherwise be retried without end. A malformed
 * request (`invalid_request`, an unsupported grant type) is a client fault sign-in cannot fix.
 */
const signInRefusals = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "invalid_target",
]);

/**
 * One refresh exchange; an unconfirmed one is sent again whatever its age, and only the server's
 * refusal asks for sign-in. A refresh that never reached the server is still current there. One
 * the server rotated is answered with the same pair for an hour, then refused. Reuse later than a
 * day revokes the token family, which is this device's own grant: each sign-in registers its own
 * OAuth client. `refreshStartedAt` is kept because saved credentials refuse unknown keys and older
 * ones carry it; nothing decides on it.
 */
export async function refreshDeviceCredentials(
  current: DeviceCredentials,
  signal: AbortSignal,
  commit: (next: DeviceCredentials) => Promise<void>,
) {
  const unknown = current.refreshPending === true;
  // A pending refresh with its start saved is already on disk as it would be written.
  if (!unknown || current.refreshStartedAt === undefined)
    await commit({ ...current, refreshPending: true, refreshStartedAt: Date.now() });
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
      signInRefusals.has(error.code) &&
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
