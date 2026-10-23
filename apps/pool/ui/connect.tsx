import { useEffect, useRef, useState } from "react";
import type { Provider, SignInStarted } from "../contract.ts";
import { callbackOrigin, isLoopbackUrl } from "../sign-in.ts";
import type { PoolApi } from "./api.ts";
import { providerName } from "./accounts.tsx";
import { Button, CheckIcon, Dialog, ExternalIcon, Problem, Spinner } from "./controls.tsx";
import { LoginFile } from "./login-file.tsx";
import { CallbackSteps, DeviceSteps, Header } from "./sign-in-steps.tsx";

type Step =
  | { kind: "pick"; error?: string }
  | { kind: "signing-in"; started: SignInStarted; submitting: boolean; error?: string }
  | { kind: "file" }
  | { kind: "connected" };

const poll = 2_000;

interface Props {
  providers: readonly Provider[];
  api: PoolApi;
  onClose: () => void;
  onConnected: () => void;
}

/** The flow mounts only while the dialog is open, so closing it ends polling and its sign-in. */
export function ConnectDialog({ open, ...props }: Props & { open: boolean }) {
  return (
    <Dialog open={open} onClose={props.onClose} label="Connect a subscription">
      <ConnectFlow {...props} />
    </Dialog>
  );
}

function ConnectFlow({ providers, api, onClose, onConnected }: Props) {
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [starting, setStarting] = useState<string>();
  // The sign-in the backend holds for us; whatever ends this flow cancels it.
  const pending = useRef<string>(undefined);
  const mounted = useRef(true);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) void api.cancel(pending.current);
    };
  }, [api]);

  const finish = () => {
    pending.current = undefined;
    setStep({ kind: "connected" });
    connectedRef.current();
  };
  const failed = (started: SignInStarted, message: string) =>
    setStep({ kind: "signing-in", started, submitting: false, error: message });

  // Device sign-ins finish on the backend's own schedule; pasted callbacks once submitted.
  // One request at a time: the next poll waits for the last answer.
  const active =
    step.kind === "signing-in" && !step.error && (step.started.flow === "device" || step.submitting)
      ? step.started
      : undefined;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const check = async () => {
      const result = await api.status(active.session);
      if (stopped) return;
      if (!result.ok && result.error !== "backend_unavailable") return failed(active, result.message);
      if (result.ok && result.value.status === "connected") return finish();
      if (result.ok && result.value.status === "failed") return failed(active, result.value.message);
      timer = setTimeout(check, poll);
    };
    timer = setTimeout(check, poll);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, api]);

  const back = () => {
    if (pending.current) void api.cancel(pending.current);
    pending.current = undefined;
    setStep({ kind: "pick" });
  };

  const start = async (provider: Provider) => {
    setStarting(provider.id);
    const result = await api.start(provider.id);
    if (!mounted.current) {
      // Closed while starting: let the backend go rather than hold this provider's sign-ins.
      if (result.ok) void api.cancel(result.value.session);
      return;
    }
    setStarting(undefined);
    if (!result.ok) return setStep({ kind: "pick", error: result.message });
    pending.current = result.value.session;
    // No window.open here: after an await, browsers treat it as a popup and block it.
    setStep({ kind: "signing-in", started: result.value, submitting: false });
  };

  const submit = async (started: SignInStarted, address: string) => {
    if (!isLoopbackUrl(address)) return failed(started, notLoopback(started));
    setStep({ kind: "signing-in", started, submitting: true });
    const result = await api.finish(started.session, address);
    if (!mounted.current) return;
    if (!result.ok) return failed(started, result.message);
    if (result.value.status === "connected") return finish();
    if (result.value.status === "failed") return failed(started, result.value.message);
  };

  const name = (id: string) => providerName(providers, id);

  return (
    <div className="grid gap-5 p-6">
      {step.kind === "pick" && (
        <>
          <Header title="Connect a subscription" body="Pick the service. You sign in on its own page, in a new tab." />
          <ul className="m-0 grid list-none gap-1 p-0" aria-label="Services">
            {providers.map((provider) => (
              <li key={provider.id}>
                <button
                  type="button"
                  disabled={starting !== undefined}
                  onClick={() => start(provider)}
                  className="flex h-10 w-full items-center justify-between rounded-md border border-border px-3 text-left text-sm font-medium outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  {provider.name}
                  {starting === provider.id ? <Spinner /> : <ExternalIcon />}
                </button>
              </li>
            ))}
          </ul>
          {step.error && <Problem>{step.error}</Problem>}
          <p className="text-xs text-muted-foreground">
            Have a login file from the pool backend?{" "}
            <Button size="inline" variant="link" className="text-xs" onClick={() => setStep({ kind: "file" })}>
              Upload it instead
            </Button>
          </p>
        </>
      )}

      {step.kind === "signing-in" && step.started.flow === "callback" && (
        <CallbackSteps
          started={step.started}
          name={name(step.started.provider)}
          submitting={step.submitting}
          error={step.error}
          onSubmit={(address) => submit(step.started, address)}
        />
      )}

      {step.kind === "signing-in" && step.started.flow === "device" && (
        <DeviceSteps started={step.started} name={name(step.started.provider)} error={step.error} />
      )}

      {step.kind === "file" && <LoginFile api={api} onBack={() => setStep({ kind: "pick" })} onConnected={finish} />}

      {step.kind === "connected" && (
        <div className="grid justify-items-start gap-3">
          <span className="grid size-8 place-items-center rounded-full bg-accent">
            <CheckIcon />
          </span>
          <Header title="Connected" body="The account is in your pool. Its limits show up once the pool backend reads them." />
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2">
        {step.kind === "signing-in" && (
          <Button variant="ghost" className="mr-auto" onClick={back}>
            Back
          </Button>
        )}
        {step.kind === "connected" ? (
          <>
            <Button variant="outline" onClick={() => setStep({ kind: "pick" })}>
              Connect another
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        )}
      </footer>
    </div>
  );
}

function notLoopback(started: SignInStarted) {
  const origin = callbackOrigin(started.url) ?? "a localhost page";
  return `That isn't the address to paste. Copy the whole address of the tab that ended on ${origin}.`;
}
