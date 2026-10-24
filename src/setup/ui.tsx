import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Computers } from "../../apps/pool/ui/computers.tsx";
import type { Computer, ComputerResult, ComputersApi, ComputersView, SetupApi, SetupLink } from "../../apps/pool/ui/computer-types.ts";
import { SetupPanel } from "../../apps/pool/ui/setup.tsx";
import { brand } from "../../brand.ts";

function App() {
  const intent = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("intent"), []);
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
    {!intent ? <p className="pt-10">Open "Set up this computer" from your pool to choose the pool for this computer. <a href="/" className="underline">Open your pool</a></p> : <>
      <div className="pt-8"><SetupPanel start={{ kind: "new" }} api={api} computers={computers} onChanged={() => void api.computers()} /></div>
      {computers.length > 0 && <Computers api={api} refreshKey={computers.length} setup={{ kind: "dialog", api }} />}
      <p className="mt-6 text-xs text-muted-foreground">Setup session expired? Reopen this page from your pool. <a href="/login" className="underline">Sign in</a> if needed.</p>
    </>}
  </div>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
