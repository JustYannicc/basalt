import { type ReactNode, useEffect, useState } from "react";
import type { SignInStarted } from "../contract.ts";
import { Button, buttonClass, ExternalIcon, Problem, Spinner } from "./controls.tsx";
import { callbackOrigin, isLoopbackUrl } from "../sign-in.ts";
import { duration } from "./usage.ts";

export function Header({ title, body }: { title: string; body: string }) {
  return (
    <header className="grid gap-1">
      <h2 className="text-base font-semibold tracking-[-0.015em] text-balance">{title}</h2>
      <p className="text-sm text-muted-foreground text-pretty">{body}</p>
    </header>
  );
}

function Expiry({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = Date.parse(at) - now;
  if (Number.isNaN(left)) return null;
  return <p className="text-xs text-muted-foreground">{left > 0 ? `This sign-in expires in ${duration(left)}.` : "This sign-in expired. Go back and start again."}</p>;
}

export function CallbackSteps({
  started,
  name,
  submitting,
  error,
  onSubmit,
}: {
  started: SignInStarted;
  name: string;
  submitting: boolean;
  error?: string;
  onSubmit: (address: string) => void;
}) {
  const [address, setAddress] = useState("");
  const origin = callbackOrigin(started.url) ?? "localhost";
  return (
    <>
      <Header title={`Sign in to ${name}`} body={`Two steps. The sign-in happens on ${name}'s own page.`} />
      <ol className="m-0 grid list-none gap-4 p-0">
        <li className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-2">
          <Num>1</Num>
          <p className="text-sm">Sign in on {name}'s page.</p>
          <OpenLink href={started.url}>
        Open {name}
      </OpenLink>
        </li>
        <li className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-2">
          <Num>2</Num>
          <p className="text-sm text-pretty">
            The tab ends on a page that won't load, at an address starting with{" "}
            <code className="rounded-sm bg-accent px-1 py-0.5 font-mono text-[0.8125rem]">{origin}</code>. That's expected.
            Copy the whole address and paste it here.
          </p>
          <form
            className="col-start-2 flex gap-2 max-[480px]:flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) onSubmit(address.trim());
            }}
          >
            <label className="sr-only" htmlFor="callback">Address from the sign-in tab</label>
            <input
              id="callback"
              value={address}
              autoComplete="off"
              spellCheck={false}
              placeholder={`${origin}/…`}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setAddress(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text").trim();
                if (!isLoopbackUrl(pasted)) return;
                event.preventDefault();
                setAddress(pasted);
                onSubmit(pasted);
              }}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-[0.8125rem] outline-none transition-[box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50"
            />
            <Button type="submit" busy={submitting} disabled={!address.trim()}>
              {submitting ? "Connecting" : "Connect"}
            </Button>
          </form>
        </li>
      </ol>
      {error && <Problem>{error}</Problem>}
      <Expiry at={started.expiresAt} />
    </>
  );
}

export function DeviceSteps({ started, name, error }: { started: SignInStarted; name: string; error?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Header
        title={`Approve on ${name}`}
        body={started.userCode ? `Enter this code on ${name}'s page, then approve.` : `Approve the sign-in on ${name}'s page.`}
      />
      {started.userCode && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-4 py-3">
          <span className="font-mono text-xl font-medium tracking-[0.12em] tabular-nums select-all">{started.userCode}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(started.userCode ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
      )}
      <OpenLink href={started.url}>
        Open {name}
      </OpenLink>
      {error ? (
        <Problem>{error}</Problem>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Spinner /> Waiting for {name}. This updates by itself.
        </p>
      )}
      <Expiry at={started.expiresAt} />
    </>
  );
}

function Num({ children }: { children: string }) {
  return (
    <span className="row-span-2 grid size-6 place-items-center rounded-full border border-border text-xs font-medium tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

/** Opens the provider's page from the person's own click, so no popup blocker stops it. */
function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${buttonClass()} w-fit`}>
      {children} <ExternalIcon />
    </a>
  );
}
