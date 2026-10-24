import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ComputerResult } from "../../apps/pool/ui/computer-types.ts";
import { Members, type MembersApi, type PoolInvitation, type ShareView } from "../../apps/pool/ui/members.tsx";
import { brand } from "../../brand.ts";

function App() {
  const intent = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("intent"), []);
  const api = useMemo<MembersApi>(() => {
    const read = async <T,>(path: string, body?: unknown, method = "GET"): Promise<ComputerResult<T>> => {
      try {
        const response = await fetch(`/share/v1/${path}`, {
          method, credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify({ intent, ...body as object }) }),
        });
        const result = await response.json();
        return response.ok ? { ok: true, value: result } : { ok: false, error: "share_failed", message: result.error || "Open sharing again from your pool." };
      } catch { return { ok: false, error: "unavailable", message: "Sharing couldn't be reached. Try again." }; }
    };
    const done = async (result: ComputerResult<unknown>): Promise<ComputerResult<null>> => result.ok ? { ok: true, value: null } : result;
    return {
      view: () => read<ShareView>(`pool?intent=${encodeURIComponent(intent ?? "")}`),
      invite: (email) => read<{ invitation: PoolInvitation }>("invitations", { email }, "POST"),
      cancel: async (id) => done(await read(`invitations/${encodeURIComponent(id)}`, {}, "DELETE")),
      remove: async (id) => done(await read(`members/${encodeURIComponent(id)}`, {}, "DELETE")),
    };
  }, [intent]);
  useEffect(() => { document.title = `Share your pool · ${brand.name}`; }, []);
  return <div className="mx-auto min-h-dvh max-w-[56rem] px-6 pb-16 max-[540px]:px-4">
    <header className="flex h-14 items-center justify-between border-b border-border"><span className="text-sm font-semibold tracking-[-0.01em]">{brand.name} <span className="font-normal text-muted-foreground">/ Share</span></span><a href="/" className="text-xs underline underline-offset-4">Open your pool</a></header>
    {!intent ? <p className="pt-10 text-sm">Open "Share" from your pool to invite people to it. <a href="/" className="underline underline-offset-4">Open your pool</a></p> : <>
      <Members api={api} />
      <p className="mt-10 text-xs text-muted-foreground">Sharing session expired? Reopen this page from your pool. <a href="/login" className="underline underline-offset-4">Sign in</a> if needed.</p>
    </>}
  </div>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
