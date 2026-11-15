export interface ScopedPreviewClientResult {
  client: "claude" | "codex";
  transport: "live" | "synthetic";
  exit: 0 | null;
  timeout: false | null;
  modelRequest: boolean;
  toolSearch: boolean;
  undo: boolean;
  revoke: boolean;
  chatgptAuthPreserved?: boolean;
  refreshTokenUntouched?: boolean;
}
export interface ScopedPreviewResult {
  version: 2;
  mode: "preview-scoped";
  signIn: boolean;
  poolEmpty: boolean;
  clients: ScopedPreviewClientResult[];
  cleanup: boolean;
}

function exact(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === names.sort().join("\n")
  );
}

/** A fixture never becomes a live-provider assertion, and partial cleanup never becomes success. */
export function scopedPreviewPassed(value: unknown): value is ScopedPreviewResult {
  if (
    !exact(value, ["version", "mode", "signIn", "poolEmpty", "clients", "cleanup"]) ||
    value.version !== 2 ||
    value.mode !== "preview-scoped" ||
    value.signIn !== true ||
    value.poolEmpty !== true ||
    value.cleanup !== true ||
    !Array.isArray(value.clients) ||
    value.clients.length !== 2
  )
    return false;
  const clients = value.clients;
  return ["claude", "codex"].every((client, index) => {
    const entry: unknown = clients[index];
    const names = [
      "client",
      "transport",
      "exit",
      "timeout",
      "modelRequest",
      "toolSearch",
      "undo",
      "revoke",
    ];
    if (client === "codex") names.push("chatgptAuthPreserved", "refreshTokenUntouched");
    return (
      exact(entry, names) &&
      entry.client === client &&
      entry.transport === (client === "claude" ? "live" : "synthetic") &&
      entry.exit === 0 &&
      entry.timeout === false &&
      ["modelRequest", "toolSearch", "undo", "revoke"].every((key) => entry[key] === true) &&
      (client !== "codex" ||
        (entry.chatgptAuthPreserved === true && entry.refreshTokenUntouched === true))
    );
  });
}
