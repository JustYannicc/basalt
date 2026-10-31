import type { ConnectionView, CredentialSource } from "../contracts/connection.ts";

/** Health reads never replay application work or interrupt an agent's active request. */
export function connectionHealth(source: CredentialSource) {
  let last: ConnectionView["health"];
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let deliberateDisconnect = false;
  const view = (): ConnectionView => {
    const current = source.view();
    if (current.state === "sign-in-required" || current.state === "revoked") return current;
    if (current.state === "disconnected" && !deliberateDisconnect && last?.state !== "offline")
      last = { state: "offline", checkedAt: Date.now() };
    return { ...current, ...(last ? { health: last } : {}) };
  };
  const reset = (disconnected = false) => {
    generation++;
    controller?.abort();
    last = undefined;
    deliberateDisconnect = disconnected;
  };
  return {
    view,
    reset,
    check: async () => {
      if (source.view().state !== "connected") return view();
      const age = last ? Date.now() - last.checkedAt : undefined;
      if (age !== undefined && age >= 0 && age < 10_000) return view();
      if (!pending) {
        const epoch = generation;
        controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
        pending = (async () => {
          let state: "online" | "offline" = "online";
          try {
            const origins = new Set(source.origins());
            if (!origins.size) throw new Error("No server is configured.");
            await Promise.all(
              [...origins].map(async (origin) => {
                // Reachability only: no credentials, refresh exchange, or application operation.
                const response = await globalThis.fetch(new URL("/", origin), {
                  method: "HEAD",
                  credentials: "omit",
                  redirect: "manual",
                  signal,
                });
                await response.body?.cancel();
                if (response.status >= 500) throw new Error("The server is unavailable.");
              }),
            );
          } catch {
            state = "offline";
          }
          if (epoch === generation) last = { state, checkedAt: Date.now() };
        })().finally(() => {
          pending = undefined;
        });
      }
      await pending;
      return view();
    },
    close: async () => {
      reset();
      await pending;
    },
  };
}
