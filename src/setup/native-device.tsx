import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Problem, buttonClass } from "../../apps/pool/ui/controls.tsx";
import { brand } from "../../brand.ts";
import { deviceCode, deviceProblem, DeviceApprovalError, readDevicePools, readDeviceRequest, reviewDeviceDecision,
  type DevicePools, type DeviceRequest } from "./native-device-api.ts";

type View = { kind: "enter" } | { kind: "loading" } | { kind: "signed-out" } |
  { kind: "error"; message: string } | { kind: "ready"; request: DeviceRequest } |
  { kind: "approved" | "denied" | "uncertain" };
const field = "min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px] max-[400px]:flex-wrap">{label}{children}</div>;
}

export function NativeDevice() {
  const [initial] = useState(() => new URLSearchParams(location.search).get("user_code") ?? "");
  const [draftCode, setDraftCode] = useState(initial);
  const [code, setCode] = useState(deviceCode(initial));
  const [view, setView] = useState<View>(initial ? deviceCode(initial) ? { kind: "loading" }
    : { kind: "error", message: "Enter the eight-letter code shown on your device." } : { kind: "enter" });
  const [revision, setRevision] = useState(0);
  const [choices, setChoices] = useState<DevicePools>();
  const [pool, setPool] = useState("");
  const [name, setName] = useState("This device");
  const [models, setModels] = useState(true);
  const [tools, setTools] = useState(true);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = `Connect this device · ${brand.name}`;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const request = await readDeviceRequest(code, controller.signal);
        if (controller.signal.aborted) return;
        setView({ kind: "ready", request });
        try {
          const available = await readDevicePools(controller.signal);
          if (controller.signal.aborted) return;
          setChoices(available);
          setPool((selected) => available.pools.some((entry) => entry.id === selected) ? selected
            : (available.pools.find((entry) => entry.mine) ?? available.pools[0])!.id);
        } catch (error) { if (!controller.signal.aborted) setProblem(deviceProblem(error)); }
      } catch (error) {
        if (controller.signal.aborted) return;
        setView(error instanceof DeviceApprovalError && error.kind === "signed-out" ? { kind: "signed-out" }
          : { kind: "error", message: deviceProblem(error) });
      }
    })();
    return () => controller.abort();
  }, [code, revision]);

  function reload() {
    setView({ kind: "loading" });
    setProblem("");
    setChoices(undefined);
    setRevision((value) => value + 1);
  }

  function enter(event: FormEvent) {
    event.preventDefault();
    const parsed = deviceCode(draftCode);
    if (!parsed) { setProblem("Enter the eight-letter code shown on your device."); return; }
    const target = new URL(location.href);
    target.search = new URLSearchParams({ user_code: parsed }).toString();
    history.replaceState(null, "", target);
    setCode(parsed);
    reload();
  }

  async function decide(accept: boolean) {
    if (mutation.current || !code || view.kind !== "ready") return;
    mutation.current = true;
    setBusy(true);
    setProblem("");
    try {
      const signal = lifetime.current!.signal;
      const result = await reviewDeviceDecision(code, view.request, signal, accept ? { name, pool, models, tools } : undefined);
      if (signal.aborted) return;
      if (result.kind === "review") {
        setView({ kind: "ready", request: result.request });
        setProblem(result.message);
        if (result.available) {
          const available = result.available;
          setChoices(available);
          setPool((available.pools.find((entry) => entry.mine) ?? available.pools[0])!.id);
        }
      } else setView({ kind: result.status });
    } catch (error) {
      if (lifetime.current?.signal.aborted) return;
      if (error instanceof DeviceApprovalError && error.kind === "uncertain") setView({ kind: "uncertain" });
      else if (error instanceof DeviceApprovalError && error.kind === "signed-out") setView({ kind: "signed-out" });
      else setProblem(deviceProblem(error));
    } finally { mutation.current = false; setBusy(false); }
  }

  const login = `/login?redirect=${encodeURIComponent(`/native/device${code ? `?user_code=${encodeURIComponent(code)}` : ""}`)}`;
  const validName = name.trim().length > 0 && name.trim().length <= 60 && /^[\x20-\x7e]+$/.test(name.trim());
  const done = view.kind === "approved" || view.kind === "denied" || view.kind === "uncertain";
  return <main className="mx-auto min-h-dvh max-w-[38rem] px-6 py-12 max-[540px]:px-4 max-[540px]:py-6">
    <article className="overflow-hidden rounded-xl border border-border">
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5 text-[13px] font-medium">
        <span>{brand.name}</span><span className="text-xs font-normal text-muted-foreground">Browser</span>
      </header>
      <div className="grid gap-6 p-7 max-[400px]:p-5">
        <div className="grid gap-1.5">
          <h1 className="text-[22px] font-medium tracking-[-0.025em] text-balance">{view.kind === "approved" ? "Device approved" : view.kind === "denied" ? "Connection denied" : view.kind === "uncertain" ? "Check your device" : "Connect this device?"}</h1>
          <p role={done ? "status" : undefined} className="text-[13px] leading-relaxed text-muted-foreground">{done
            ? view.kind === "approved" ? "Return to your device to finish connecting. You can close this tab."
              : view.kind === "denied" ? "This request was denied. You can close this tab."
              : "Signalbox could not confirm your decision. Return to your device to check its status before starting a new request."
            : "Approve access in your browser."}</p>
        </div>
        {view.kind === "loading" && <p role="status" className="text-sm text-muted-foreground">Checking your device request…</p>}
        {(view.kind === "enter" || view.kind === "error") && <form onSubmit={enter} className="grid gap-4">
          {view.kind === "error" && <Problem>{view.message}</Problem>}
          <label className="grid gap-2 text-[13px]">Device code<input className={field} value={draftCode} onChange={(event) => setDraftCode(event.target.value)} maxLength={20} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="BCDF-GHJK" required /></label>
          {problem && <Problem>{problem}</Problem>}
          <div><Button type="submit">Review device</Button></div>
        </form>}
        {view.kind === "signed-out" && <a href={login} className={buttonClass()}>Sign in to review this device</a>}
        {view.kind === "ready" && <>
          <div className="text-[13px]">
            <Row label="Account"><span className="min-w-0 break-words text-right text-muted-foreground">{view.request.account.email}</span></Row>
            <Row label="Requesting app"><span className="min-w-0 break-words text-right text-muted-foreground">{view.request.clientName}</span></Row>
            <Row label={<label htmlFor="native-pool">Models from</label>}><select id="native-pool" className={`${field} max-w-[65%]`} disabled={!choices || busy || !models} value={pool} onChange={(event) => setPool(event.target.value)}>
              {!choices && <option value="">{problem ? "Pools unavailable" : "Loading pools…"}</option>}
              {choices?.pools.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || (entry.mine ? "Your pool" : "Shared pool")}</option>)}
            </select></Row>
            <Row label="Tools"><span className="text-right text-muted-foreground">Your connected apps</span></Row>
          </div>
          <fieldset disabled={busy} className="grid min-w-0 gap-3 border-0 p-0">
            <label className="grid gap-2 text-[13px]" htmlFor="native-name">Device name<input id="native-name" className={field} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-describedby="native-name-help" /></label>
            <p id="native-name-help" className="text-xs text-muted-foreground">Use letters A-Z, numbers, spaces or punctuation. Rename it later in Connections.</p>
            <p className="text-[13px] text-muted-foreground">Confirm this code matches the one on your device: <strong className="whitespace-nowrap font-mono text-foreground">{code}</strong></p>
            <label className="flex items-start gap-2.5 text-[13px]"><input type="checkbox" className="mt-1 size-4 accent-primary" checked={models} onChange={(event) => setModels(event.target.checked)} />Use models from the selected pool</label>
            <label className="flex items-start gap-2.5 text-[13px]"><input type="checkbox" className="mt-1 size-4 accent-primary" checked={tools} onChange={(event) => setTools(event.target.checked)} />Use your cloud tools with their existing permissions</label>
          </fieldset>
          <p className="text-[13px] text-muted-foreground">You can revoke this device later in Connections.</p>
          {problem && <div className="grid gap-2"><Problem>{problem}</Problem>{!choices && <div className="flex flex-wrap items-center gap-4"><Button variant="outline" disabled={busy} onClick={reload}>Try again</Button><a className="text-sm underline underline-offset-4" href="/setup">Open Connections</a></div>}</div>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !choices || !pool || !validName || (!models && !tools)} onClick={() => void decide(true)}>{busy ? "Confirming…" : "Connect device"}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
          </div>
        </>}
      </div>
    </article>
  </main>;
}
