import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Computers } from "../../apps/pool/ui/computers.tsx";
import type { Computer, ComputerResult, ComputersApi, ComputersView, SetupApi, SetupLink } from "../../apps/pool/ui/computer-types.ts";
import { Button, buttonClass, Problem, Spinner } from "../../apps/pool/ui/controls.tsx";
import { SetupPanel } from "../../apps/pool/ui/setup.tsx";
import { brand } from "../../brand.ts";

/** The signed intent comes from the pool's link in the hash, or from the signed-in person's own pool. */
type Context = { kind: "loading" } | { kind: "ready"; intent: string } | { kind: "signin" } | { kind: "failed"; message: string };

/** Reads the intent only; nothing here mints credentials. */
async function ownContext(): Promise<Context> {
  try {
    const response = await fetch("/setup/v1/context", { credentials: "same-origin" });
    const result = await response.json().catch(() => ({}));
    if (response.ok && typeof result.intent === "string" && result.intent) return { kind: "ready", intent: result.intent };
    if (response.status === 401) return { kind: "signin" };
    return { kind: "failed", message: typeof result.error === "string" && result.error ? result.error : "Couldn't open setup. Try again." };
  } catch { return { kind: "failed", message: "Setup couldn't be reached. Try again." }; }
}

function App() {
  const [context, setContext] = useState<Context>(() => {
    const intent = new URLSearchParams(location.hash.slice(1)).get("intent");
    return intent ? { kind: "ready", intent } : { kind: "loading" };
  });
  const intent = context.kind === "ready" ? context.intent : null;
  useEffect(() => {
    if (context.kind !== "loading") return;
    let live = true;
    void ownContext().then((next) => {
      if (!live) return;
      if (next.kind === "ready") {
        // Keep the intent in the hash so a reload resumes the same setup without fetching again.
        const hash = new URLSearchParams(location.hash.slice(1));
        hash.set("intent", next.intent);
        history.replaceState(history.state, "", `${location.pathname}${location.search}#${hash}`);
      }
      setContext(next);
    });
    return () => { live = false; };
  }, [context.kind]);
  const [computers, setComputers] = useState<ComputersView["computers"]>([]);
  const api = useMemo(() => {
    const read = async <T,>(path: string, body?: unknown, method = "GET"): Promise<ComputerResult<T>> => {
      try {
        const response = await fetch(`/setup/v1/${path}`, {
          method, credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify({ intent, ...body as object }) }),
        });
        const result = await response.json();
        return response.ok ? { ok: true, value: result } : { ok: false, error: "setup_failed", message: result.error || "Open setup again from your pool." };
      } catch { return { ok: false, error: "unavailable", message: "Setup couldn't be reached. Try again." }; }
    };
    const result: ComputersApi & SetupApi = {
      computers: async () => {
        const result = await read<ComputersView>(`computers?intent=${encodeURIComponent(intent ?? "")}`);
        if (result.ok) setComputers(result.value.computers);
        return result;
      },
      createSetup: (name) => read<SetupLink>("links", { name }, "POST"),
      switchPool: async (id, pool) => {
        const result = await read<{ computer: Computer }>(`computers/${encodeURIComponent(id)}/pool`, { pool }, "POST");
        return result.ok ? { ok: true, value: result.value.computer } : result;
      },
      refreshSetup: (computerId) => read<SetupLink>("links", { computerId }, "POST"),
      revoke: async (id) => {
        const result = await read(`computers/${encodeURIComponent(id)}?intent=${encodeURIComponent(intent ?? "")}`, undefined, "DELETE");
        return result.ok ? { ok: true, value: null } : result;
      },
    };
    return result;
  }, [intent]);
  useEffect(() => { document.title = `Set up this computer · ${brand.name}`; }, []);
  useEffect(() => { if (intent) void api.computers(); }, [api, intent]);
  return <div className="mx-auto min-h-dvh max-w-[56rem] px-6 pb-16 max-[540px]:px-4">
    <header className="flex h-14 items-center justify-between border-b border-border"><span className="font-semibold">{brand.name} <span className="font-normal text-muted-foreground">/ Computer setup</span></span><a href="/" className="text-xs underline underline-offset-4">Open your pool</a></header>
    {context.kind === "loading" ? <p role="status" className="flex items-center gap-2 pt-10 text-sm text-muted-foreground"><Spinner />Finding your pool…</p>
    : context.kind === "signin" ? <p className="pt-10">Sign in to set up this computer. <a href="/login?redirect=%2Fsetup" className="underline">Sign in</a></p>
    : context.kind === "failed" ? <div className="grid justify-items-start gap-3 pt-10"><Problem>{context.message}</Problem><div className="flex gap-2"><Button onClick={() => setContext({ kind: "loading" })}>Try again</Button><a href="/" className={buttonClass("outline")}>Open your pool</a></div></div>
    : <>
      <div className="pt-8"><SetupPanel start={{ kind: "new" }} api={api} computers={computers} onChanged={() => void api.computers()} /></div>
      {computers.length > 0 && <Computers api={api} refreshKey={computers.length} setup={{ kind: "dialog", api }} />}
      <p className="mt-6 text-xs text-muted-foreground">Setup session expired? <a href="/setup" className="underline">Set up this computer</a> again. <a href="/login" className="underline">Sign in</a> if needed.</p>
    </>}
  </div>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
