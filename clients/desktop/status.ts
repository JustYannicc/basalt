import type { ConnectionView } from "../contracts/connection.ts";

/** What the connection page's "Models from" row says, and whether it offers choosing a pool. */
export function modelsRow(view: ConnectionView | undefined, connected: boolean) {
  // A tools-only device uses no pool, so its access answer names none. A disconnected device keeps
  // that answer but no capabilities, so the name is what still tells.
  const toolsOnly = view?.display?.pool.name === "";
  const text =
    toolsOnly || (connected && !view?.capabilities.includes("models"))
      ? "Not included in this connection"
      : view?.display?.pool.name ||
        (view?.mode === "direct" ? "Your direct key" : "Reconnect to load pool details");
  return { text, choosePool: view?.mode === "device" && !toolsOnly };
}
