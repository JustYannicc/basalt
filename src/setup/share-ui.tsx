import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../apps/pool/ui/controls.tsx";
import { brand } from "../../brand.ts";

function App() {
  const intent = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("intent"), []);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => { document.title = `Share your pool · ${brand.name}`; }, []);
  useEffect(() => {
    if (!intent) return;
    const controller = new AbortController();
    setError(undefined);
    void (async () => {
      try {
        const response = await fetch(`/share/v1/destination?intent=${encodeURIComponent(intent)}`, {
          credentials: "same-origin", signal: controller.signal,
        });
        const result: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok && typeof result === "object" && result !== null && "href" in result
          && typeof result.href === "string" && result.href.startsWith("/org/")) {
          location.replace(result.href);
          return;
        }
        setError(typeof result === "object" && result !== null && "error" in result
          && typeof result.error === "string" ? result.error : "Sharing settings could not be opened. Try again.");
      } catch {
        if (!controller.signal.aborted) setError("Sharing couldn't be reached. Try again.");
      }
    })();
    return () => controller.abort();
  }, [intent, attempt]);
  return <div className="mx-auto min-h-dvh max-w-[56rem] px-6 pb-16 max-[540px]:px-4">
    <header className="flex h-14 items-center justify-between border-b border-border"><span className="text-sm font-semibold tracking-[-0.01em]">{brand.name} <span className="font-normal text-muted-foreground">/ Share</span></span><a href="/" className="text-xs underline underline-offset-4">Open your pool</a></header>
    <div className="pt-10 text-sm">
      {!intent ? <p>Open "Share" from your pool to manage its access in Settings.</p>
        : error ? <><p role="alert">{error}</p><Button variant="outline" size="sm" className="mt-4" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></>
        : <p role="status">Opening this pool's settings...</p>}
    </div>
  </div>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
