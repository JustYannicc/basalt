import { type ReactNode, useEffect, useId, useState } from "react";
import type { SetupLink } from "./computer-types.ts";
import { Button } from "./controls.tsx";

export function Fallback({ link, stale }: { link: SetupLink; stale: boolean }) {
  const [shell, setShell] = useState<"posix" | "powershell">(() =>
    navigator.platform.toLowerCase().startsWith("win") ? "powershell" : "posix",
  );
  const options = [
    { id: "posix", label: "macOS and Linux" },
    { id: "powershell", label: "Windows" },
  ] as const;
  return (
    <>
      <p className="text-sm text-muted-foreground text-pretty">
        Run this in a terminal on that computer. It fetches the same instructions through the same link.
      </p>
      <div role="group" aria-label="Shell" className="flex w-fit gap-1 rounded-md bg-accent p-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={shell === option.id}
            onClick={() => setShell(option.id)}
            className="h-7 rounded-[4px] px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs max-[740px]:h-9"
          >
            {option.label}
          </button>
        ))}
      </div>
      {shell === "posix" ? (
        <CopyBlock label="Shell command" text={link.command} copyLabel="Copy command" stale={stale} />
      ) : (
        <CopyBlock label="PowerShell command" text={link.powershellCommand} copyLabel="Copy command" stale={stale} />
      )}
    </>
  );
}

export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        {summary}
        <svg
          className="size-3.5 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="grid gap-3 pb-4">{children}</div>
    </details>
  );
}

/** Text to paste somewhere else. If the clipboard is off limits, the text stays selectable. */
export function CopyBlock({
  label,
  text,
  copyLabel,
  stale = false,
  primary = false,
}: {
  label: string;
  text: string;
  copyLabel: string;
  stale?: boolean;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState<"yes" | "failed">();
  const id = useId();
  useEffect(() => setCopied(undefined), [text]);
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted p-3">
      <div className="flex items-center justify-between gap-2">
        <span id={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Button
          size="xs"
          variant={primary && !stale ? "default" : "outline"}
          disabled={stale}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied("yes");
            } catch {
              setCopied("failed");
            }
          }}
        >
          {copied === "yes" ? "Copied" : copyLabel}
        </Button>
      </div>
      <pre
        aria-labelledby={id}
        className={`m-0 max-h-40 overflow-y-auto font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] select-all ${
          stale ? "text-muted-foreground line-through decoration-muted-foreground/50" : ""
        }`}
      >
        {text}
      </pre>
      {copied === "failed" && (
        <p role="alert" className="text-xs text-muted-foreground">
          This browser blocked copying. Select the text above and copy it yourself.
        </p>
      )}
    </div>
  );
}
