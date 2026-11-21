import type { ConnectionView } from "../contracts/connection.ts";

/** What the connection page's "Models from" row says, and whether it offers choosing a pool. */
export function modelsRow(view: ConnectionView | undefined, connected: boolean) {
  const text =
    connected && !view?.capabilities.includes("models")
      ? "Not included in this connection"
      : view?.display?.pool.name ||
        (view?.mode === "direct" ? "Your direct key" : "Reconnect to load pool details");
  return { text, choosePool: view?.mode === "device" };
}
