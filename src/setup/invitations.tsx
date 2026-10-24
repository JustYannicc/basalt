import { useEffect, useId, useState } from "react";
import { Button, Problem } from "../../apps/pool/ui/controls.tsx";
import type { PoolInvitation } from "./members.tsx";
import { duration } from "../../apps/pool/ui/usage.ts";

// Inviting people to a pool and the invitations still waiting.

const inputClass =
  "h-9 min-w-0 flex-1 max-[480px]:flex-none rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-[box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50 max-[740px]:h-11";

export function InviteForm({ disabled, onInvite }: { disabled: boolean; onInvite: (email: string) => Promise<string | undefined> }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const trimmed = email.trim();
  return (
    <form
      className="grid max-w-[34rem] gap-1.5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!trimmed || busy) return;
        setBusy(true);
        setError(undefined);
        const problem = await onInvite(trimmed);
        setBusy(false);
        if (problem) setError(problem);
        else setEmail("");
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Invite by email
      </label>
      <div className="flex gap-2 max-[480px]:flex-col">
        <input
          id={id}
          type="email"
          value={email}
          autoComplete="off"
          spellCheck={false}
          placeholder="name@example.com"
          disabled={disabled || busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClass}
        />
        <Button type="submit" busy={busy} disabled={disabled || !trimmed}>
          Invite
        </Button>
      </div>
      {error ? (
        <Problem>{error}</Problem>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground text-pretty">
          They join as a member. The link in their email works for 7 days.
        </p>
      )}
    </form>
  );
}

export function InvitationRow({ invitation, now, onCancel }: { invitation: PoolInvitation; now: number; onCancel: () => Promise<boolean> }) {
  const [cancelling, setCancelling] = useState(false);
  const expires = invitation.expiresAt ? Date.parse(invitation.expiresAt) : NaN;
  const expired = Number.isFinite(expires) && expires <= now;
  const status = expired
    ? "Invite expired"
    : Number.isFinite(expires)
      ? `Invited, link works for ${duration(expires - now)}`
      : "Invited";
  return (
    <li className="grid gap-2 border-b border-border px-1 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <span className="block truncate text-muted-foreground" title={invitation.email}>
          {invitation.email}
        </span>
        <span className={`block text-xs ${expired ? "text-warning" : "text-muted-foreground"}`}>
          {Number.isFinite(expires) ? <time dateTime={invitation.expiresAt ?? undefined}>{status}</time> : status}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:justify-end">
        {!expired && <CopyLink link={invitation.link} label="Copy link" />}
        <Button
          size="inline"
          variant="link"
          className="text-xs text-muted-foreground"
          busy={cancelling}
          aria-label={`Cancel the invitation for ${invitation.email}`}
          onClick={async () => {
            setCancelling(true);
            await onCancel();
            setCancelling(false);
          }}
        >
          {expired ? "Remove" : "Cancel"}
        </Button>
      </div>
    </li>
  );
}

/** Copies the link; if the browser refuses, shows it selectable instead. */
export function CopyLink({ link, label, primary = false }: { link: string; label: string; primary?: boolean }) {
  const [state, setState] = useState<"copied" | "failed">();
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState(undefined), 2_000);
    return () => clearTimeout(timer);
  }, [state]);
  if (state === "failed")
    return (
      <input
        readOnly
        aria-label="Invite link"
        value={link}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7 w-[min(18rem,100%)] rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    );
  return (
    <Button
      size={primary ? "xs" : "inline"}
      variant={primary ? "outline" : "link"}
      className={primary ? "" : "text-xs text-muted-foreground"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(link);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : label}</span>
    </Button>
  );
}
