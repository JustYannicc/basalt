import { useCallback, useEffect, useId, useState } from "react";
import type { ComputerResult } from "./computer-types.ts";
import { Button, Problem } from "./controls.tsx";
import { duration } from "./usage.ts";

// Who can use a pool, inviting more people and removing them. Structural like the computers API:
// the page never sees an organization's internals, only people and invitations.

export interface PoolMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly owner: boolean;
  readonly you: boolean;
}
export interface PoolInvitation {
  readonly id: string;
  readonly email: string;
  /** ISO time the link stops working, or null when the host didn't say. */
  readonly expiresAt: string | null;
  /** The invite link; it works for someone without an account too. */
  readonly link: string;
}
export interface ShareView {
  readonly pool: { readonly id: string; readonly name: string };
  /** `private` until the first invite, then `everyone` in the pool's organization; `groups` when the owner chose groups. */
  readonly audience: string;
  readonly members: readonly PoolMember[];
  readonly invitations: readonly PoolInvitation[];
}
export interface MembersApi {
  view: () => Promise<ComputerResult<ShareView>>;
  invite: (email: string) => Promise<ComputerResult<{ invitation: PoolInvitation }>>;
  cancel: (invitationId: string) => Promise<ComputerResult<null>>;
  /** Their computer keys on this pool are revoked before this returns; their next request fails. */
  remove: (memberId: string) => Promise<ComputerResult<null>>;
}

const inputClass =
  "h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-[box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50 max-[740px]:h-11";

function useShare(api: MembersApi) {
  const [view, setView] = useState<ShareView>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const result = await api.view();
    if (result.ok) {
      setView(result.value);
      setError(undefined);
    } else setError(result.message);
  }, [api]);
  useEffect(() => {
    void load();
    // Accepted invitations turn into members while this page is open.
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  return { view, error, load };
}

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

export function Members({ api }: { api: MembersApi }) {
  const { view, error, load } = useShare(api);
  const now = useNow();
  const [actionError, setActionError] = useState<string>();
  const [invited, setInvited] = useState<PoolInvitation>();
  const name = view?.pool.name.trim();
  const members = view ? view.members.filter((member) => !member.you).length : 0;
  const pending = view?.invitations.length ?? 0;
  const others = members + pending;

  const act = async (work: () => Promise<ComputerResult<unknown>>) => {
    setActionError(undefined);
    const result = await work();
    if (!result.ok) {
      setActionError(result.message);
      return false;
    }
    await load();
    return true;
  };

  return (
    <section aria-labelledby="share-heading" className="grid gap-8 pt-10">
      <div className="grid gap-1">
        <h1 id="share-heading" className="text-2xl font-semibold tracking-[-0.025em] text-balance">
          {view === undefined ? "Share your pool" : `Share ${name || "your pool"}`}
        </h1>
        <p className="max-w-[40rem] text-sm text-muted-foreground text-pretty">
          People you invite use this pool from their own computers. They see each account's limits, never its
          credentials, and their tools stay their own.
        </p>
      </div>

      <InviteForm
        disabled={view === undefined}
        onInvite={async (email) => {
          setActionError(undefined);
          setInvited(undefined);
          const result = await api.invite(email);
          if (!result.ok) return result.message;
          setInvited(result.value.invitation);
          await load();
          return undefined;
        }}
      />

      {invited && (
        <div role="status" className="-mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-muted px-4 py-3">
          <p className="min-w-0 text-sm text-pretty">
            Invited <span className="font-medium [overflow-wrap:anywhere]">{invited.email}</span>. They'll get an email; you can
            also send them the link.
          </p>
          <CopyLink link={invited.link} label="Copy invite link" primary />
        </div>
      )}

      {view?.audience === "groups" && (
        <p className="-mt-4 max-w-[40rem] text-sm text-muted-foreground text-pretty">
          You share this pool with groups. Add the people you invite to one of them in the dashboard, or they won't be
          able to use it.
        </p>
      )}

      <div className="grid gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">People</h2>
          {view && others > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {[members && `${members} ${members === 1 ? "member" : "members"}`, pending && `${pending} invited`].filter(Boolean).join(", ")}
            </span>
          )}
        </div>
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <Problem>{error}</Problem>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {actionError && <Problem>{actionError}</Problem>}
        {view === undefined ? (
          !error && <Skeleton />
        ) : (
          <>
            <ul aria-label="People" className="m-0 list-none border-t border-border p-0">
              {view.members.map((member) => (
                <MemberRow key={member.id} member={member} onRemove={() => act(() => api.remove(member.id))} />
              ))}
              {view.invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  now={now}
                  onCancel={() => act(() => api.cancel(invitation.id))}
                />
              ))}
            </ul>
            {others === 0 && (
              <p className="text-sm text-muted-foreground text-pretty">
                Nobody else uses this pool yet. An invite link works for people without an account too.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function InviteForm({ disabled, onInvite }: { disabled: boolean; onInvite: (email: string) => Promise<string | undefined> }) {
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

function Person({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-w-0">
      <span className="block truncate font-medium" title={title}>
        {title}
      </span>
      {detail && (
        <span className="block truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}

function MemberRow({ member, onRemove }: { member: PoolMember; onRemove: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const title = member.name.trim() || member.email || "Unnamed member";
  const remove = async () => {
    setRemoving(true);
    const removed = await onRemove();
    setRemoving(false);
    if (removed) setConfirming(false);
  };
  return (
    <li className="group grid gap-2 border-b border-border px-1 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <Person title={title} detail={member.name.trim() ? member.email : ""} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:justify-end">
        {member.owner || member.you ? (
          <span className="text-muted-foreground">{member.you ? (member.owner ? "You, owner" : "You") : "Owner"}</span>
        ) : confirming ? (
          <>
            <span className="text-muted-foreground text-pretty">
              Remove {title}? Their computers on this pool stop on their next request.
            </span>
            <Button size="xs" variant="destructive" busy={removing} onClick={remove}>
              Remove
            </Button>
            <Button size="xs" variant="ghost" disabled={removing} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Member</span>
            <Button
              size="inline"
              variant="link"
              className="text-xs text-muted-foreground [@media(pointer:fine)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={`Remove ${title}`}
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function InvitationRow({ invitation, now, onCancel }: { invitation: PoolInvitation; now: number; onCancel: () => Promise<boolean> }) {
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
function CopyLink({ link, label, primary = false }: { link: string; label: string; primary?: boolean }) {
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

function Skeleton() {
  return (
    <div aria-hidden="true" className="grid border-t border-border">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center justify-between gap-6 border-b border-border px-1 py-4">
          <div className="grid gap-1.5">
            <div className="h-4 w-36 animate-pulse rounded-sm bg-accent" />
            <div className="h-3 w-48 animate-pulse rounded-sm bg-accent" />
          </div>
          <div className="h-3 w-14 animate-pulse rounded-sm bg-accent" />
        </div>
      ))}
    </div>
  );
}
