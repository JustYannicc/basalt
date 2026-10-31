import type { AgentSelection, SetupPreview, DesktopSnapshot } from "./contracts.ts";

const names = { claude: "Claude Code", codex: "Codex" } as const;

export function AgentSetup({
  selection,
  configured,
  disabled,
  connected,
  hasSetup,
  reviewing,
  preview,
  busy,
  error,
  onSelection,
  onReview,
  onApply,
  onCancel,
}: {
  selection: AgentSelection;
  configured: DesktopSnapshot["configured"];
  disabled: boolean;
  connected: boolean;
  hasSetup: boolean;
  reviewing: boolean;
  preview: SetupPreview | undefined;
  busy: boolean;
  error: string | undefined;
  onSelection(client: keyof AgentSelection, choice: AgentSelection["claude"]): void;
  onReview(undo: boolean): void;
  onApply(id: string): void;
  onCancel(): void;
}) {
  return (
    <section className="section" aria-labelledby="agents-title">
      <div className="heading">
        <h2 id="agents-title">Connect your agents</h2>
        <p className="secondary">
          Choose which settings to update. Unchecking a configured agent restores its previous
          settings.
        </p>
      </div>
      <div>
        {(["codex", "claude"] as const).map((client) => (
          <div className="agent" key={client}>
            <label>
              <input
                type="checkbox"
                checked={selection[client] !== "undo"}
                disabled={disabled || (!connected && !configured[client])}
                onChange={(event) => onSelection(client, event.target.checked ? "connect" : "undo")}
              />
              {names[client]}
            </label>
            {configured[client] && selection[client] !== "undo" ? (
              <select
                aria-label={`${names[client]} settings`}
                value={selection[client]}
                disabled={disabled}
                onChange={(event) =>
                  onSelection(client, event.target.value === "keep" ? "keep" : "connect")
                }
              >
                <option value="keep">Keep current settings</option>
                <option value="connect" disabled={!connected}>
                  Use this connection
                </option>
              </select>
            ) : (
              <span className="secondary">
                {configured[client]
                  ? "Restore previous"
                  : selection[client] === "connect"
                    ? "Use this connection"
                    : "Not configured"}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="actions">
        <button
          disabled={
            disabled ||
            !(
              Object.values(selection).includes("connect") ||
              (["claude", "codex"] as const).some(
                (client) => configured[client] && selection[client] === "undo",
              )
            )
          }
          onClick={() => onReview(false)}
        >
          Review changes
        </button>
        {hasSetup && (
          <button className="plain" disabled={disabled} onClick={() => onReview(true)}>
            Undo agent setup
          </button>
        )}
      </div>
      {reviewing && (
        <section className="notice review" aria-label="Review agent setup">
          <h2>Review changes</h2>
          <p>
            Only these managed settings will change. Backups are kept. Later unrelated edits stay
            yours.
          </p>
          {preview && (
            <ul>
              {preview.files.map((file) => (
                <li key={file.path}>
                  <strong>
                    {file.action === "keep"
                      ? "Keep"
                      : file.action === "restore"
                        ? "Restore"
                        : "Update"}
                  </strong>
                  <code>{file.path}</code>
                  {file.fields.length > 0 && <small>{file.fields.join(", ")}</small>}
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !preview}
              onClick={() => {
                if (preview) onApply(preview.id);
              }}
            >
              Apply changes
            </button>
            <button
              disabled={busy}
              onClick={() => {
                onCancel();
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
