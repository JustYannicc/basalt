import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entry, Match, VaultApi } from "./api.ts";
import { vaultState, noteTitle, type Devices, type ImportStatus, type Version } from "./model.ts";
import { Reader } from "./reader.tsx";
import { Summary } from "./summary.tsx";
import { Tree } from "./tree.tsx";

interface Loaded {
  readonly status: ImportStatus | null;
  readonly root: readonly Entry[];
  readonly latest: Version | null;
  readonly devices: Devices | null;
}

export function App({ api }: { readonly api: VaultApi }) {
  const [loaded, setLoaded] = useState<Loaded | "failed" | null>(null);
  const [walked, setWalked] = useState<{ paths: readonly string[]; complete: boolean }>({
    paths: [],
    complete: false,
  });
  const files = walked.paths;
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Relative times ("4 minutes ago") age with the page instead of freezing at load.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.importStatus(), api.list(undefined), api.latest(), api.devices()])
      .then(([status, root, history, devices]) => {
        if (cancelled) return;
        setLoaded({
          status,
          root: root.entries,
          latest: history,
          devices,
        });
        // Wikilinks resolve against every path; the tree itself loads folder by folder.
        api.walk().then(
          (result) => !cancelled && setWalked(result),
          () => undefined,
        );
      })
      .catch(() => !cancelled && setLoaded("failed"));
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  if (loaded === null) return <p className="page-message">Loading your vault…</p>;
  if (loaded === "failed")
    return (
      <div className="page-message">
        <p>Couldn't load the vault.</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setLoaded(null);
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  const state = vaultState({
    status: loaded.status,
    hasFiles: loaded.root.length > 0,
    latest: loaded.latest,
    devices: loaded.devices,
    now,
  });
  if (state.kind === "empty") return <EmptyVault />;
  return (
    <div className={`vault ${selected === null ? "" : "has-note"}`}>
      <Summary
        name="Your vault"
        state={state}
        files={files.length ? { count: files.length, complete: walked.complete } : null}
        latest={loaded.latest}
        now={now}
      />
      <div className="browser">
        <aside className="side">
          <Search api={api} files={files} onSelect={setSelected} />
          <Tree api={api} root={loaded.root} selected={selected} onSelect={setSelected} />
        </aside>
        {selected === null ? (
          <div className="reader placeholder">
            <p className="muted">Choose a note to read it.</p>
          </div>
        ) : (
          <Reader
            key={selected}
            api={api}
            path={selected}
            files={files}
            onOpen={setSelected}
            onBack={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function EmptyVault() {
  return (
    <div className="empty">
      <h1>Nothing synced yet</h1>
      <p>
        Use the Connect button at the top of this page to keep an Obsidian vault here. Your agents
        can then read, search and edit your notes, even with every device off.
      </p>
      <ol className="steps">
        <li>
          <b>Start with your Mac</b>
          <span>It has every note, so it imports the vault.</span>
        </li>
        <li>
          <b>Approve in your browser</b>
          <span>Obsidian opens, then asks you to approve the device here.</span>
        </li>
        <li>
          <b>Add your phone later</b>
          <span>Once your Mac has synced, choose Connect another device at the top.</span>
        </li>
      </ol>
    </div>
  );
}

/** Names match instantly from the vault's paths; text matches come from the server. */
function Search({
  api,
  files,
  onSelect,
}: {
  readonly api: VaultApi;
  readonly files: readonly string[];
  readonly onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{
    readonly query: string;
    readonly result: readonly Match[] | "failed";
  } | null>(null);
  const trimmed = query.trim();
  // Only the answer for the current query counts; anything else is still searching.
  const text: readonly Match[] | "loading" | "failed" =
    trimmed.length < 2 ? [] : answer?.query === trimmed ? answer.result : "loading";
  useEffect(() => {
    if (trimmed.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.search(trimmed).then(
        (matches) => !cancelled && setAnswer({ query: trimmed, result: matches }),
        () => !cancelled && setAnswer({ query: trimmed, result: "failed" }),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, trimmed]);
  const names = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return needle.length < 1
      ? []
      : files.filter((path) => path.toLowerCase().includes(needle)).slice(0, 20);
  }, [files, trimmed]);
  const pick = useCallback(
    (path: string) => {
      onSelect(path);
      setQuery("");
    },
    [onSelect],
  );
  const textMatches = Array.isArray(text)
    ? text.filter((match) => !names.includes(match.path))
    : [];
  return (
    <div className="search">
      <input
        type="search"
        placeholder="Search notes"
        aria-label="Search notes"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {trimmed.length > 0 && (
        <ul className="results">
          {names.map((path) => (
            <li key={`name:${path}`}>
              <button type="button" onClick={() => pick(path)}>
                <span className="label">{noteTitle(path.split("/").pop() ?? path)}</span>
                <span className="excerpt">{path}</span>
              </button>
            </li>
          ))}
          {textMatches.map((match) => (
            <li key={`text:${match.path}:${match.line}`}>
              <button type="button" onClick={() => pick(match.path)}>
                <span className="label">
                  {noteTitle(match.path.split("/").pop() ?? match.path)}
                </span>
                <span className="excerpt">{match.excerpt}</span>
              </button>
            </li>
          ))}
          {text === "loading" && <li className="muted">Searching…</li>}
          {text === "failed" && <li className="muted">Search didn't finish. Try again.</li>}
          {Array.isArray(text) &&
            trimmed.length >= 2 &&
            names.length + textMatches.length === 0 && <li className="muted">No notes match.</li>}
        </ul>
      )}
    </div>
  );
}
