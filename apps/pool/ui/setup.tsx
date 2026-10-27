import { useEffect, useId, useRef, useState } from "react";
import { productName } from "../deployment.ts";
import {
  canRefresh,
  type Computer,
  computerStatus,
  nameLimit,
  type SetupApi,
  type SetupLink,
} from "./computer-types.ts";
import { Button, CheckIcon, Dialog, Header, Problem, Spinner } from "./controls.tsx";
import { CopyBlock, Disclosure, Fallback } from "./setup-controls.tsx";
import { duration } from "./usage.ts";

export { CopyBlock } from "./setup-controls.tsx";

/** Where setup starts: naming a new computer, or on a link already minted for one. */
export type SetupStart = { readonly kind: "new" } | { readonly kind: "link"; readonly name: string; readonly link: SetupLink };

type Step =
  | { kind: "name"; busy: boolean; error?: string }
  | { kind: "link"; name: string; link: SetupLink; refreshing: boolean; error?: string };

interface Props {
  start: SetupStart;
  api: SetupApi;
  /** The latest list, so setup can show this computer turning green. */
  computers: readonly Computer[];
  /** Leaving setup. Without it, as on a page of its own, there's no Cancel or Done. */
  onClose?: () => void;
  /** A computer was created; reload the list. */
  onChanged: () => void;
}

export function SetupDialog({ open, ...props }: Props & { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={props.onClose} label="Set up this computer">
      <SetupPanel {...props} />
    </Dialog>
  );
}

/** The whole setup, for a dialog or a page of its own. Mount it fresh for each setup. */
export function SetupPanel({ start, api, computers, onClose, onChanged }: Props) {
  const [step, setStep] = useState<Step>(() =>
    start.kind === "new" ? { kind: "name", busy: false } : { kind: "link", name: start.name, link: start.link, refreshing: false },
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const create = async (name: string) => {
    setStep({ kind: "name", busy: true });
    const result = await api.createSetup(name);
    if (!mounted.current) return;
    if (!result.ok) return setStep({ kind: "name", busy: false, error: result.message });
    setStep({ kind: "link", name, link: result.value, refreshing: false });
    onChanged();
  };

  const refresh = async (name: string, link: SetupLink) => {
    setStep({ kind: "link", name, link, refreshing: true });
    const result = await api.refreshSetup(link.computerId);
    if (!mounted.current) return;
    if (!result.ok) return setStep({ kind: "link", name, link, refreshing: false, error: result.message });
    setStep({ kind: "link", name, link: result.value, refreshing: false });
  };

  return (
    <div className="grid gap-5 p-6">
      {step.kind === "name" ? (
        <NameStep busy={step.busy} error={step.error} onSubmit={create} onCancel={onClose} />
      ) : (
        <>
          <LinkStep
            name={step.name}
            link={step.link}
            refreshing={step.refreshing}
            error={step.error}
            computer={computers.find((computer) => computer.id === step.link.computerId)}
            onRefresh={() => refresh(step.name, step.link)}
            onStartOver={() => setStep({ kind: "name", busy: false })}
          />
          {onClose && (
            <footer className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </footer>
          )}
        </>
      )}
    </div>
  );
}

/** A starting name from the browser's platform; the person can change it. */
function guessName(): string {
  const platform = navigator.platform.toLowerCase();
  if (platform.startsWith("mac")) return "Mac";
  if (platform.startsWith("win")) return "Windows PC";
  if (platform.includes("linux")) return "Linux computer";
  return "";
}

function NameStep({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(guessName);
  const id = useId();
  const trimmed = name.trim();
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <Header
        title="Set up this computer"
        body={`Connects Claude Code and Codex on this computer to ${productName}, using this pool. You paste one short prompt into either agent.`}
      />
      <div className="grid gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          Computer name
        </label>
        <input
          id={id}
          value={name}
          maxLength={nameLimit}
          autoComplete="off"
          autoFocus
          placeholder="Work laptop"
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setName(event.target.value)}
          className="h-9 min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-[box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50"
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Only you see it, in your list of computers.
        </p>
      </div>
      {error && <Problem>{error}</Problem>}
      <footer className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" busy={busy} disabled={!trimmed}>
          Get the setup prompt
        </Button>
      </footer>
    </form>
  );
}

function useSecondsTick(every = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

function LinkStep({
  name,
  link,
  refreshing,
  error,
  computer,
  onRefresh,
  onStartOver,
}: {
  name: string;
  link: SetupLink;
  refreshing: boolean;
  error?: string;
  computer: Computer | undefined;
  onRefresh: () => void;
  onStartOver: () => void;
}) {
  const now = useSecondsTick();
  const left = Date.parse(link.expiresAt) - now;
  const expired = !Number.isNaN(left) && left <= 0;
  // Once claimed, the link is spent; only revoking and a new setup replace it.
  const claimed = computer !== undefined && !canRefresh(computer);
  const stale = expired || claimed;
  return (
    <>
      <Header
        title={`Set up ${name}`}
        body="Paste this into Claude Code or Codex on that computer. The agent backs up your settings, sets up both apps, and tells you when it's done."
      />

      <div className="grid gap-2">
        <CopyBlock label="Setup prompt" text={link.prompt} copyLabel="Copy prompt" stale={stale} primary />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p
            className={`text-xs tabular-nums ${expired && !claimed ? "text-destructive" : "text-muted-foreground"}`}
            aria-live="polite"
          >
            {claimed
              ? "The link inside was used. It doesn't work again."
              : expired
                ? "The link inside expired. Revoke this computer in your list of computers, then set up a new one."
                : Number.isNaN(left)
                  ? "The link inside works once."
                  : `The link inside works once and expires in ${duration(left)}.`}
          </p>
          {!stale && (
            <Button size="xs" variant="ghost" busy={refreshing} onClick={onRefresh}>
              Get a new link
            </Button>
          )}
          {expired && !claimed && (
            <Button size="xs" variant="outline" onClick={onStartOver}>
              Set up a new computer
            </Button>
          )}
        </div>
        {error && <Problem>{error}</Problem>}
      </div>

      <ol className="m-0 grid list-decimal gap-1.5 pl-5 text-sm text-pretty marker:text-muted-foreground">
        <li>Wait for the agent to say it's done.</li>
        <li>Restart Claude Code and Codex.</li>
        <li>Send a message in each. This computer turns green once a model request and a tool call arrive.</li>
      </ol>

      <Progress computer={computer} />

      <div className="grid gap-1.5 text-xs text-muted-foreground text-pretty">
        <p>
          In Codex, sign in with any ChatGPT account, even a free one. Requests still run on this pool. Account-side Codex
          features follow that account's own plan.
        </p>
        <p>
          Covers Claude Code in the terminal and VS Code, and Codex in the terminal, IDE extension and desktop app. The
          Claude desktop app isn't covered. It ignores these settings.
        </p>
      </div>

      <div className="grid border-t border-border">
        <Disclosure summary="No agent? Run a command instead">
          <Fallback link={link} stale={stale} />
        </Disclosure>
        <Disclosure summary="Undo this setup later">
          <p className="text-sm text-muted-foreground text-pretty">
            Paste this into the agent on that computer. It removes only what setup added and restores your backups. To
            cut the computer off right away, revoke it in your list of computers.
          </p>
          <CopyBlock label="Undo prompt" text={link.undoPrompt} copyLabel="Copy undo prompt" />
        </Disclosure>
      </div>
    </>
  );
}

function Progress({ computer }: { computer: Computer | undefined }) {
  const status = computer ? computerStatus(computer) : "waiting";
  if (status === "connected") {
    return (
      <p className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
        <span className="grid size-5 place-items-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500">
          <CheckIcon className="size-3.5" />
        </span>
        Connected. A model request and a tool call arrived.
      </p>
    );
  }
  const text = {
    waiting: "Waiting for the first model request and tool call. This updates by itself.",
    "model-only": "A model request arrived. Waiting for a tool call.",
    "tools-only": "A tool call arrived. Waiting for a model request.",
    revoking: "Revoking hasn't finished, so this computer may still work. Retry it from your list of computers.",
    revoked: "This computer was revoked. Its requests fail.",
    removed: "You no longer have this computer's pool, so its model requests fail.",
  }[status];
  const settled = status === "revoked" || status === "revoking" || status === "removed";
  return (
    <p className={`flex items-center gap-2 text-sm ${status === "revoking" ? "text-warning" : "text-muted-foreground"}`} aria-live="polite">
      {!settled && <Spinner />}
      {text}
    </p>
  );
}
