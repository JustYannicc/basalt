import { useState } from "react";
import { canRefresh, type Computer, computerStatus, type ComputerStatus } from "./computer-types.ts";
import { Button, buttonClass, CheckIcon, ExternalIcon } from "./controls.tsx";
import { duration, exactTime } from "./usage.ts";

/** "just now", "3h 12m ago". */
function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return now - at < 60_000 ? "just now" : `${duration(now - at)} ago`;
}

const statusText: Record<ComputerStatus, string> = {
  connected: "Connected",
  "model-only": "Waiting for a tool call",
  "tools-only": "Waiting for a model request",
  waiting: "Waiting for first request",
  revoking: "Revoke not finished",
  revoked: "Revoked",
};

function StatusDot({ status }: { status: ComputerStatus }) {
  const tone = {
    connected: "bg-emerald-600 dark:bg-emerald-500",
    "model-only": "border border-warning bg-warning/40",
    "tools-only": "border border-warning bg-warning/40",
    waiting: "border border-muted-foreground",
    revoking: "bg-warning",
    revoked: "bg-muted-foreground/40",
  }[status];
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

export function ComputerRow({
  computer,
  now,
  opening,
  setupHref,
  manageHref,
  onNewLink,
  onRevoke,
}: {
  computer: Computer;
  now: number;
  opening: boolean;
  /** Set when setup happens on another page. */
  setupHref: string | undefined;
  manageHref?: string;
  onNewLink: () => void;
  onRevoke: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const status = computerStatus(computer);
  const revoked = status === "revoked";
  // Only an unclaimed link rotates. A claimed computer is replaced by revoking it and setting up a new one.
  const refreshable = canRefresh(computer);
  const revoke = async () => {
    setRevoking(true);
    await onRevoke();
    // The list now says whether it finished; a revoke still in flight can be retried.
    setRevoking(false);
    setConfirming(false);
  };
  return (
    <li className="group grid gap-3 border-b border-border px-1 py-4 last:border-b-0 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div className="min-w-0">
        <span className={`block truncate font-medium ${revoked ? "text-muted-foreground" : ""}`} title={computer.name}>
          {computer.name}
        </span>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs">
          <StatusDot status={status} />
          <span
            className={
              status === "connected"
                ? "font-medium text-emerald-700 dark:text-emerald-400"
                : status === "revoking"
                  ? "font-medium text-warning"
                  : "text-muted-foreground"
            }
          >
            {statusText[status]}
          </span>
        </div>
        {!revoked && (
          <div
            className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs transition-opacity duration-150 ${
              confirming || status !== "connected"
                ? ""
                : "[@media(pointer:fine)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
          >
            {manageHref ? (
              <a
                href={manageHref}
                target="_blank"
                rel="noopener"
                className={`${buttonClass("link", "inline")} text-xs text-muted-foreground`}
              >
                Manage computer <ExternalIcon />
              </a>
            ) : status === "revoking" ? (
              <>
                <span className="text-muted-foreground">It may still work until this finishes.</span>
                <Button size="xs" variant="destructive" busy={revoking} onClick={revoke}>
                  Retry revoke
                </Button>
              </>
            ) : confirming ? (
              <>
                <span className="text-muted-foreground">Revoke? Its next request fails.</span>
                <Button
                  size="xs"
                  variant="destructive"
                  busy={revoking}
                  onClick={revoke}
                >
                  Revoke
                </Button>
                <Button size="xs" variant="ghost" disabled={revoking} onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                {!refreshable ? null : setupHref ? (
                  <a
                    href={setupHref}
                    target="_blank"
                    rel="noopener"
                    className={`${buttonClass("link", "inline")} text-xs text-muted-foreground`}
                  >
                    Get the setup prompt
                  </a>
                ) : (
                  <Button size="inline" variant="link" className="text-xs text-muted-foreground" busy={opening} onClick={onNewLink}>
                    Get the setup prompt
                  </Button>
                )}
                <Button
                  size="inline"
                  variant="link"
                  className="text-xs text-muted-foreground"
                  aria-label={`Revoke ${computer.name}`}
                  onClick={() => setConfirming(true)}
                >
                  Revoke
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <dl className="m-0 grid content-center gap-1.5 text-xs">
        {revoked ? (
          <Evidence label="Revoked" at={computer.revokedAt} now={now} none="" muted />
        ) : (
          <>
            <Evidence label="Model request" at={computer.firstModelRequestAt} now={now} none="None yet" />
            <Evidence label="Tool call" at={computer.firstToolCallAt} now={now} none="None yet" />
          </>
        )}
        <Evidence label="Added" at={computer.createdAt} now={now} none="" muted />
      </dl>
    </li>
  );
}

/** One line of what the pool has actually seen from this computer. */
function Evidence({
  label,
  at,
  now,
  none,
  muted = false,
}: {
  label: string;
  at: string | null;
  now: number;
  none: string;
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1rem_7rem_1fr] items-center gap-x-1.5">
      <span aria-hidden="true" className="grid place-items-center text-muted-foreground">
        {muted ? null : at ? (
          <CheckIcon className="size-3.5 text-emerald-700 dark:text-emerald-400" />
        ) : (
          <span className="size-2 rounded-full border border-muted-foreground" />
        )}
      </span>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 tabular-nums">
        {at ? (
          <time dateTime={at} title={exactTime(at)} className={muted ? "text-muted-foreground" : "text-foreground"}>
            {muted ? ago(at, now) : `First ${ago(at, now)}`}
          </time>
        ) : (
          <span className="text-muted-foreground">{none}</span>
        )}
      </dd>
    </div>
  );
}
