import { type ReactNode, useId, useRef, useState } from "react";
import { Button, buttonClass, Problem } from "./controls.tsx";
import { openImportSource } from "./import-source.ts";
import type { ImportProgress, ImportSession } from "./import-session.ts";

const count = (value: number | string) => BigInt(value).toLocaleString();
const date = (value: string | null) =>
  value === null
    ? "—"
    : new Date(value).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });

export function ImportView({
  session,
  progress,
  previous,
  back,
}: {
  session: ImportSession;
  progress: ImportProgress;
  previous: boolean;
  back: () => void;
}) {
  const { phase } = progress;
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const fileId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = phase === "previewing" || phase === "importing";
  const selecting = phase === "choose" || (phase === "error" && !session.canResume());
  const message = error ?? progress.error;
  const choose = async (file: File | undefined) => {
    if (!file || opening || busy) return;
    setError(undefined);
    setOpening(true);
    try {
      const source = await openImportSource(file);
      setOpening(false);
      await session.preview(source);
      heading.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't read this usage export.");
    } finally {
      setOpening(false);
    }
  };
  return (
    <main className="mx-auto w-full max-w-[56rem] px-6 pb-16 max-[540px]:px-4">
      <nav className="py-5">
        <Button variant="link" size="inline" onClick={back}>
          ← Back to pool
        </Button>
      </nav>
      <header className="mb-8 grid gap-2">
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-[-0.025em] outline-none"
        >
          {phase === "complete"
            ? "Usage imported"
            : phase === "importing"
              ? "Importing usage"
              : "Import usage"}
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground text-pretty">
          {busy
            ? "You can return to the pool while this runs. Keep this browser tab open."
            : "Bring past request dates, models, tokens and outcomes into this pool."}
        </p>
      </header>
      <section className="grid max-w-[42rem] gap-6" aria-label="Usage import">
        {previous && selecting && (
          <p className="text-sm text-muted-foreground">
            An earlier import ran in this tab. Choose the same export to continue; existing records
            will be skipped.
          </p>
        )}
        {message && <Problem>{message}</Problem>}
        {selecting ? (
          <>
            <div className="grid gap-3 rounded-lg border border-dashed border-input p-6 sm:p-8">
              <label htmlFor={fileId} className="text-base font-medium">
                Choose a usage export
              </label>
              <p className="text-sm text-muted-foreground">
                Prepared metadata JSONL or a legacy CPA JSON snapshot.
              </p>
              <input
                id={fileId}
                type="file"
                accept=".jsonl,.json,application/json"
                disabled={opening}
                className="block min-h-11 w-full max-w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-foreground"
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {opening && (
                <p role="status" className="text-sm">
                  Reading export…
                </p>
              )}
            </div>
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>Manager Plus: prepared metadata JSONL. Home: its usage export in JSONL.</p>
              <p>
                Older CPA: a v0/v1 JSON snapshot, up to 8 MiB. Only retained request details can be
                imported; totals alone cannot become history.
              </p>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">What comes across?</summary>
              <p className="mt-2 max-w-xl text-muted-foreground">
                Request metadata only. Prompts, responses and other message content are removed on
                your device. The preview checks every page without adding records.
              </p>
            </details>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
              <strong className="min-w-0 break-all text-sm font-medium">{progress.label}</strong>
              {!busy && (
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => {
                    session.reset();
                    setError(undefined);
                  }}
                >
                  Choose another file
                </Button>
              )}
            </div>
            <dl className="grid gap-3 text-sm">
              <Fact label={phase === "complete" ? "Records checked" : "Metadata records found"}>
                {count(progress.total)}
              </Fact>
              <Fact label="Date range">
                {date(progress.from)} – {date(progress.to)} · UTC
              </Fact>
              <Fact label="Attribution">Imported history</Fact>
              <Fact label="API cost">Unpriced</Fact>
              {phase !== "previewing" && (
                <Fact label="Already imported">{count(progress.existing)}</Fact>
              )}
              {phase !== "review" && phase !== "previewing" && (
                <Fact label="Added">{count(progress.added)}</Fact>
              )}
              {progress.aggregateOnly !== "0" && (
                <Fact label="Totals without retained details">
                  {count(progress.aggregateOnly)} not importable
                </Fact>
              )}
            </dl>
            {progress.indistinguishable > 0 && (
              <p className="text-sm text-muted-foreground">
                {count(progress.indistinguishable)} legacy details have no unique request identity.
                Their occurrence count is preserved.
              </p>
            )}
            {busy && (
              <div className="grid gap-2" role="status">
                {phase === "importing" && (
                  <progress
                    className="h-2 w-full accent-foreground"
                    max={Math.max(1, progress.total)}
                    value={progress.checked}
                    aria-label="Import progress"
                  />
                )}
                <p className="text-sm tabular-nums">
                  {count(progress.checked)}
                  {phase === "importing" ? ` of ${count(progress.total)}` : ""} records checked
                  {phase === "previewing" ? " · no records added" : ""}
                </p>
              </div>
            )}
            {phase === "review" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Existing records are skipped. Importing the same export again won't add
                  duplicates.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => void session.apply()}>Import usage</Button>
                  <Button variant="outline" onClick={back}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {busy && (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={back}>
                  Back to pool
                </Button>
                <Button variant="link" onClick={() => session.pause()}>
                  {phase === "previewing" ? "Cancel preview" : "Pause import"}
                </Button>
              </div>
            )}
            {(phase === "paused" || phase === "error") && session.canResume() && (
              <>
                <p className="text-sm text-muted-foreground">
                  Records already added are kept. Resume checks the interrupted page again and skips
                  existing records.
                </p>
                <div>
                  <Button onClick={() => void session.apply()}>Resume import</Button>
                </div>
              </>
            )}
            {phase === "complete" && (
              <div className="flex flex-wrap gap-3">
                <a className={buttonClass()} href="#usage-history">
                  View all history →
                </a>
                <Button variant="outline" onClick={() => session.reset()}>
                  Import another export
                </Button>
              </div>
            )}
          </>
        )}
        <div className="border-t border-border pt-5 text-sm">
          <p className="font-medium">Imported history · Unpriced</p>
          <p className="mt-1 max-w-xl text-muted-foreground text-pretty">
            Kept separate from people. It won't use anyone's weekly cap. Closing this tab stops the
            import; choose the export again to resume safely.
          </p>
        </div>
      </section>
    </main>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium tabular-nums sm:text-right">{children}</dd>
    </div>
  );
}
