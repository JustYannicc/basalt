/**
 * Basalt-side Connect Obsidian button. Framework-free so any Basalt page can mount it.
 * It never imports "obsidian"; it runs in the person's browser inside Basalt.
 *
 * The parent wires `createConnection` to Basalt's existing browser-only route that creates
 * the app-scoped MCP connection. The button then opens `obsidian://signalbox-sync?...`, where the
 * plugin shows the vault and server and starts device authorization.
 */
import type { DeviceConfig } from "./controller.ts";
import { buildConnectLink } from "./link.ts";

export interface ConnectProducer {
  /** Creates (or reuses) this person's app-scoped connection. Runs with their browser session. */
  createConnection(): Promise<DeviceConfig>;
}

export function mountConnectButton(
  target: HTMLElement,
  input: { producer: ConnectProducer; vaultName?: string; label?: string },
): () => void {
  const label = input.label ?? "Connect Obsidian";
  const root = document.createElement("div");
  const button = document.createElement("button");
  const note = document.createElement("p");
  button.type = "button";
  button.textContent = label;
  note.hidden = true;
  root.append(button, note);
  target.append(root);

  const onClick = async () => {
    button.disabled = true;
    button.textContent = "Opening Obsidian…";
    note.hidden = true;
    try {
      const config = await input.producer.createConnection();
      const link = buildConnectLink(
        input.vaultName ? { ...config, vaultName: input.vaultName } : config,
      );
      window.location.assign(link);
      // Browsers that drop the navigation after an async step still get a one-click way through.
      note.replaceChildren("Obsidian didn't open? ");
      const anchor = document.createElement("a");
      anchor.href = link;
      anchor.textContent = "Open it here";
      note.append(anchor, ". Install the Signalbox Sync plugin first if you haven't.");
      note.hidden = false;
    } catch (failure) {
      note.textContent =
        failure instanceof Error ? failure.message : "Couldn't prepare the connection. Try again.";
      note.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };
  button.addEventListener("click", onClick);
  return () => {
    button.removeEventListener("click", onClick);
    root.remove();
  };
}
