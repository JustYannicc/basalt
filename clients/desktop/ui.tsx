import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { brand } from "../../brand.ts";
import {
  readDesktopReply,
  type DesktopApi,
  type DesktopRequest,
  type DesktopSnapshot,
  type AgentSelection,
  type SetupPreview,
} from "./contracts.ts";

declare global {
  interface Window {
    signalboxClient: DesktopApi;
  }
}
import { AgentSetup } from "./AgentSetup.tsx";

function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [selection, setSelection] = useState<AgentSelection>({ claude: "undo", codex: "undo" });
  const [server, setServer] = useState(`https://${brand.host}`);
  const [preview, setPreview] = useState<SetupPreview>();
  const [reviewing, setReviewing] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef(false),
    generation = useRef(0),
    initialized = useRef(false);
  const receive = (value: DesktopSnapshot) => {
    setSnapshot(value);
    if (!initialized.current && value.phase !== "starting") {
      initialized.current = true;
      setSelection({
        claude: value.configured.claude ? "keep" : "undo",
        codex: value.configured.codex ? "keep" : "undo",
      });
      if (value.connection?.origin) setServer(value.connection.origin);
    }
  };
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (document.hidden || active.current) return;
      const current = ++generation.current;
      try {
        const reply = readDesktopReply(await window.signalboxClient.request({ action: "status" }));
        if (!disposed && current === generation.current) receive(reply.snapshot);
      } catch {
        if (!disposed)
          setNotice(
            "The connection window stopped responding. Quit and reopen the app to recover.",
          );
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const perform = async (request: DesktopRequest) => {
    if (active.current) return;
    active.current = true;
    generation.current++;
    setBusy(true);
    setNotice("");
    try {
      const reply = readDesktopReply(await window.signalboxClient.request(request));
      receive(reply.snapshot);
      if (reply.preview) setPreview(reply.preview);
      if (request.action === "setup-apply" && !reply.snapshot.error) {
        setPreview(undefined);
        setReviewing(false);
        setSelection({
          claude: reply.snapshot.configured.claude ? "keep" : "undo",
          codex: reply.snapshot.configured.codex ? "keep" : "undo",
        });
        setNotice(
          "Agent settings updated. Restart the selected agents to use the change. Backups are kept.",
        );
      }
      if (request.action === "cancel-preview") {
        setReviewing(false);
        setPreview(undefined);
      }
      if (request.action === "revoke") setRevoke(false);
    } catch {
      setNotice("This action could not finish. Check the connection and try again.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const view = snapshot?.connection;
  const connected = view?.state === "connected";
  const signing = snapshot?.phase === "signing-in";
  const starting = !snapshot || snapshot.phase === "starting";
  const disabled = busy || signing || starting;
  const configured = snapshot?.configured ?? { claude: false, codex: false };
  const hasSetup = configured.claude || configured.codex;
  const modelAccess = view?.capabilities.includes("models");
  const toolAccess = view?.capabilities.includes("tools");
  const title = starting
    ? "Starting your connection"
    : signing
      ? "Approve this device"
      : connected
        ? "You're connected"
        : view?.state === "revoked"
          ? "This device was revoked"
          : view?.state === "disconnected" || snapshot.canReconnect
            ? "Disconnected"
            : "Connect your models and tools";
  const description = signing
    ? "Finish sign-in and choose a pool in your browser. Check that the code matches."
    : starting
      ? "Your saved connection and agent settings are loading."
      : connected
        ? `Your agents can use ${modelAccess && toolAccess ? "your models and tools" : modelAccess ? "your models" : "your tools"}.`
        : "Sign in with your browser, or reconnect to resume a saved connection.";
  const changeSelection = (client: keyof AgentSelection, choice: AgentSelection["claude"]) => {
    setSelection({ ...selection, [client]: choice });
    setPreview(undefined);
    setReviewing(false);
    void perform({ action: "cancel-preview" });
  };
  const review = (undo: boolean) => {
    setReviewing(true);
    setPreview(undefined);
    void perform(undo ? { action: "undo-preview" } : { action: "setup-preview", selection });
  };
  return (
    <main>
      <header>
        <span>{brand.name}</span>
        <span>This computer</span>
      </header>
      <div className="content">
        <section className="heading">
          <h1>{title}</h1>
          <p className="secondary">{description}</p>
        </section>
        {!starting && (
          <p className="connection-state" role="status">
            <span aria-hidden="true" className={connected ? "dot connected" : "dot"} />
            {signing
              ? "Waiting for browser approval"
              : connected
                ? "Connected"
                : view?.state === "sign-in-required"
                  ? "Sign-in required"
                  : view?.state === "revoked"
                    ? "Access stopped"
                    : "Disconnected"}
          </p>
        )}
        {signing && (
          <section className="notice" aria-label="Browser approval">
            {snapshot.authorization ? (
              <>
                <p>
                  Confirmation code <code className="code">{snapshot.authorization.code}</code>
                </p>
                <p className="approval-url">{snapshot.authorization.url}</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    void perform({ action: "open-approval" });
                  }}
                >
                  Open browser
                </button>
              </>
            ) : (
              <p>Preparing browser approval…</p>
            )}
            <button
              className="plain"
              disabled={busy}
              onClick={() => {
                void perform({ action: "cancel-sign-in" });
              }}
            >
              Cancel sign-in
            </button>
          </section>
        )}
        {(view || connected) && (
          <section aria-label="Account and pool" className="account">
            <div className="row">
              <span>Account</span>
              <span className="value">
                {view?.display?.account.name ||
                  (view?.mode === "direct" ? "Direct credentials" : "Account details unavailable")}
                {view?.display?.account.email &&
                  view.display.account.email !== view.display.account.name && (
                    <small>{view.display.account.email}</small>
                  )}
              </span>
            </div>
            <div className="row">
              <span>Models from</span>
              <div className="value">
                <span>
                  {connected && !modelAccess
                    ? "Not included in this connection"
                    : view?.display?.pool.name ||
                      (view?.mode === "direct"
                        ? "Your direct key"
                        : "Reconnect to load pool details")}
                </span>
                {view?.mode === "device" && (
                  <button
                    className="plain"
                    disabled={disabled}
                    onClick={() => {
                      void perform({ action: "sign-in", origin: view.origin ?? server });
                    }}
                  >
                    Choose pool in browser
                  </button>
                )}
              </div>
            </div>
            <div className="row">
              <span>Tools</span>
              <span className="value">
                {toolAccess
                  ? "Your connected apps"
                  : connected
                    ? "Not included in this connection"
                    : "Available after reconnecting"}
              </span>
            </div>
          </section>
        )}
        {!signing && !starting && (
          <div className="actions">
            {!connected && (
              <button
                className="primary"
                disabled={disabled}
                onClick={() => {
                  void perform({ action: "sign-in", origin: server });
                }}
              >
                Sign in with your browser
              </button>
            )}
            {snapshot.canReconnect && (
              <button
                disabled={disabled || connected}
                onClick={() => {
                  void perform({ action: "reconnect" });
                }}
              >
                Reconnect
              </button>
            )}
            {connected && (
              <button
                disabled={disabled}
                onClick={() => {
                  void perform({ action: "disconnect" });
                }}
              >
                Disconnect
              </button>
            )}
          </div>
        )}
        {!starting && !signing && (connected || hasSetup) && (
          <AgentSetup
            selection={selection}
            configured={configured}
            disabled={disabled}
            connected={connected}
            hasSetup={hasSetup}
            reviewing={reviewing}
            preview={preview}
            busy={busy}
            error={snapshot.error}
            onSelection={changeSelection}
            onReview={review}
            onApply={(id) => {
              void perform({ action: "setup-apply", id });
            }}
            onCancel={() => {
              void perform({ action: "cancel-preview" });
            }}
          />
        )}
        {(notice || (snapshot?.error && !reviewing)) && (
          <p className="notice" role={snapshot?.error ? "alert" : "status"}>
            {notice || snapshot?.error}
          </p>
        )}
        {!starting && !signing && (
          <details>
            <summary>Connection details</summary>
            {snapshot.localOrigin && (
              <p>
                Models <code>{snapshot.localOrigin}/v1</code>
                <br />
                Tools <code>{snapshot.localOrigin}/mcp</code>
              </p>
            )}
            <p>
              Each agent uses its own local credential. Remote credentials stay in the OS credential
              store.
            </p>
            <label className="server">
              Server address
              <input
                type="url"
                value={server}
                disabled={busy}
                onChange={(event) => setServer(event.target.value)}
              />
            </label>
            <button
              className="plain"
              disabled={disabled}
              onClick={() => {
                void perform({ action: "import-direct" });
              }}
            >
              Import a private direct-credentials file
            </button>
          </details>
        )}
        {snapshot?.canReconnect && !signing && (
          <footer>
            <button
              className="plain"
              disabled={disabled}
              onClick={() => {
                void perform({ action: "sign-out" });
              }}
            >
              Sign out
            </button>
            {view?.mode === "device" && (
              <button className="plain danger" disabled={disabled} onClick={() => setRevoke(true)}>
                Revoke this device
              </button>
            )}
          </footer>
        )}
        {revoke && (
          <section className="notice" aria-label="Confirm device revocation">
            <p>
              Revoke this device? Models and tools will stop working here. Your other devices stay
              connected.
            </p>
            <div className="actions">
              <button
                className="danger"
                disabled={disabled}
                onClick={() => {
                  void perform({ action: "revoke" });
                }}
              >
                Revoke device
              </button>
              <button disabled={disabled} onClick={() => setRevoke(false)}>
                Keep device
              </button>
            </div>
          </section>
        )}
        <p className="background-help secondary">
          Closing this window keeps your connection running. Use Quit in the app menu to stop it.
        </p>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The client window is missing its root.");
createRoot(root).render(<App />);
