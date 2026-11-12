import { useCallback, useEffect, useState } from "react";
import type { VaultApi } from "./api.ts";
import { imageType } from "./links.ts";
import { authorLabel, when, isNote, noteTitle, type Devices, type Version } from "./model.ts";
import { NoteMarkdown } from "./note-markdown.tsx";

type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly value: T };

/** Loads whenever `load` changes identity; a result for an older `load` is never shown. */
function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void] {
  const [settled, setSettled] = useState<{
    readonly load: () => Promise<T>;
    readonly attempt: number;
    readonly state: Load<T>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => !cancelled && setSettled({ load, attempt, state: { kind: "ready", value } }),
      () => !cancelled && setSettled({ load, attempt, state: { kind: "failed" } }),
    );
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);
  const state: Load<T> =
    settled !== null && settled.load === load && settled.attempt === attempt
      ? settled.state
      : { kind: "loading" };
  return [state, () => setAttempt((value) => value + 1)];
}

/** Versions only count as per-note history when the server dates them. */
const datedVersions = (versions: Version[] | null) =>
  versions !== null && versions.every((version) => typeof version.time === "string")
    ? versions
    : null;

export function Reader({
  api,
  path,
  files,
  devices,
  onOpen,
  onBack,
}: {
  readonly api: VaultApi;
  readonly path: string;
  readonly files: readonly string[];
  readonly devices: Devices | null;
  readonly onOpen: (path: string) => void;
  readonly onBack: () => void;
}) {
  // The parent keys this reader by path, so a new note starts on its current text.
  const [view, setView] = useState<"note" | "history">("note");
  const [version, setVersion] = useState<Version | null>(null);
  const [versions] = useLoad(
    useCallback(() => api.history({ path, limit: 50 }).then(datedVersions), [api, path]),
  );
  const at = version?.oid;
  const [content, retry] = useLoad(
    useCallback(() => (isNote(path) ? api.read(path, at) : Promise.resolve(null)), [api, path, at]),
  );
  const loadFile = useCallback(
    async (file: string) => {
      const type = imageType(file);
      return type === null ? null : api.attachment(file, type);
    },
    [api],
  );
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const dated = versions.kind === "ready" ? versions.value : null;
  const current = dated?.[0];
  return (
    <article className="reader">
      <header className="reader-head">
        <button type="button" className="back" onClick={onBack}>
          ‹ {parts.at(-1) ?? "Vault"}
        </button>
        {parts.length > 0 && <p className="crumb">{parts.join(" / ")}</p>}
        <h2 className="title">{isNote(name) ? noteTitle(name) : name}</h2>
        {current?.time !== undefined && (
          <p className="meta">
            Changed {when(current.time)} · {authorLabel(current.author, devices)}
          </p>
        )}
        {isNote(path) && (
          <div className="seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === "note"}
              onClick={() => setView("note")}
            >
              Note
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "history"}
              onClick={() => setView("history")}
            >
              History{dated !== null ? ` · ${dated.length}` : ""}
            </button>
          </div>
        )}
      </header>
      <div className="reader-body">
        {!isNote(path) ? (
          <FilePreview path={path} load={loadFile} />
        ) : view === "history" ? (
          <History
            versions={versions}
            devices={devices}
            onPick={(picked) => {
              setVersion(picked.oid === current?.oid ? null : picked);
              setView("note");
            }}
          />
        ) : (
          <>
            {version !== null && (
              <div className="banner">
                <span>
                  You're reading the version from {when(version.time ?? "")}, by{" "}
                  {authorLabel(version.author, devices)}.
                </span>
                <button type="button" className="btn sm" onClick={() => setVersion(null)}>
                  Back to current
                </button>
              </div>
            )}
            {content.kind === "loading" ? (
              <p className="muted">Loading…</p>
            ) : content.kind === "failed" ? (
              <p className="muted">
                Couldn't load this note.{" "}
                <button type="button" className="link" onClick={retry}>
                  Try again
                </button>
              </p>
            ) : content.value === null ? (
              <p className="muted">This note isn't in the vault any more.</p>
            ) : (
              <NoteMarkdown
                content={content.value}
                files={files}
                onOpen={onOpen}
                loadFile={loadFile}
              />
            )}
          </>
        )}
      </div>
    </article>
  );
}

function History({
  versions,
  devices,
  onPick,
}: {
  readonly versions: Load<Version[] | null>;
  readonly devices: Devices | null;
  readonly onPick: (version: Version) => void;
}) {
  if (versions.kind === "loading") return <p className="muted">Loading…</p>;
  if (versions.kind === "failed" || versions.value === null)
    return <p className="muted">Versions of this note appear after the next Signalbox update.</p>;
  if (versions.value.length === 0) return <p className="muted">No saved versions yet.</p>;
  return (
    <ol className="versions">
      {versions.value.map((version, index) => (
        <li key={version.oid}>
          <button type="button" onClick={() => onPick(version)}>
            <span className={`pip ${index === 0 ? "current" : ""}`} aria-hidden />
            <span className="who">
              {authorLabel(version.author, devices)}
              {version.author?.kind === "agent" && <span className="tag">Agent</span>}
              {index === 0 && <span className="tag">Current</span>}
            </span>
            <span className="t">{when(version.time ?? "")}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function FilePreview({
  path,
  load,
}: {
  readonly path: string;
  readonly load: (path: string) => Promise<Blob | null>;
}) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    load(path)
      .then((blob) => {
        if (cancelled) return;
        made = blob === null ? null : URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [path, load]);
  if (url === undefined) return <p className="muted">Loading…</p>;
  if (url === null)
    return <p className="muted">This file can't be shown here. Open it in Obsidian.</p>;
  return <img src={url} alt={path.split("/").pop()} className="embed-image" />;
}
