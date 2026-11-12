import { useCallback, useEffect, useState } from "react";
import type { Entry, VaultApi } from "./api.ts";
import { isNote, noteTitle, sortEntries } from "./model.ts";

const openKey = "obsidian-vault:open-folders";
const readOpen = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(openKey) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
};
const writeOpen = (open: ReadonlySet<string>) => {
  try {
    localStorage.setItem(openKey, JSON.stringify([...open]));
  } catch {
    // Storage is a convenience; the tree works without it.
  }
};

export function Tree({
  api,
  root,
  selected,
  onSelect,
}: {
  readonly api: VaultApi;
  readonly root: readonly Entry[];
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen()));
  const toggle = useCallback((path: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      writeOpen(next);
      return next;
    });
  }, []);
  return (
    <ul className="tree" aria-label="Vault files">
      {sortEntries(root).map((entry) => (
        <Node
          key={entry.path}
          api={api}
          entry={entry}
          depth={0}
          open={open}
          toggle={toggle}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function Node(props: {
  readonly api: VaultApi;
  readonly entry: Entry;
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly toggle: (path: string) => void;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const { api, entry, depth, open, toggle, selected, onSelect } = props;
  const isOpen = entry.kind === "directory" && open.has(entry.path);
  const [children, setChildren] = useState<Entry[] | null | "failed">(null);
  useEffect(() => {
    if (!isOpen || children !== null) return;
    let cancelled = false;
    api
      .list(entry.path)
      .then((page) => !cancelled && setChildren(page.entries))
      .catch(() => !cancelled && setChildren("failed"));
    return () => {
      cancelled = true;
    };
  }, [api, entry.path, isOpen, children]);
  const indent = { paddingLeft: `${8 + depth * 16}px` };
  if (entry.kind === "file")
    return (
      <li>
        <button
          type="button"
          className={`row ${selected === entry.path ? "selected" : ""}`}
          style={indent}
          aria-current={selected === entry.path ? "page" : undefined}
          onClick={() => onSelect(entry.path)}
        >
          <Icon kind="file" />
          <span className="label">{isNote(entry.name) ? noteTitle(entry.name) : entry.name}</span>
        </button>
      </li>
    );
  return (
    <li>
      <button
        type="button"
        className="row"
        style={indent}
        aria-expanded={isOpen}
        onClick={() => toggle(entry.path)}
      >
        <Icon kind={isOpen ? "folder-open" : "folder"} />
        <span className="label">{entry.name}</span>
      </button>
      {isOpen && (
        <ul>
          {children === null ? (
            <li className="row muted" style={{ paddingLeft: `${24 + depth * 16}px` }}>
              Loading…
            </li>
          ) : children === "failed" ? (
            <li className="row muted" style={{ paddingLeft: `${24 + depth * 16}px` }}>
              Couldn't load this folder.{" "}
              <button type="button" className="link" onClick={() => setChildren(null)}>
                Try again
              </button>
            </li>
          ) : children.length === 0 ? (
            <li className="row muted" style={{ paddingLeft: `${24 + depth * 16}px` }}>
              Empty folder
            </li>
          ) : (
            sortEntries(children).map((child) => (
              <Node key={child.path} {...props} entry={child} depth={depth + 1} />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

// Inline, not CSS data URLs: the app compiler refuses a stylesheet's data: imports.
const iconPaths = {
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  "folder-open": ["M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H8l-3 8", "M5 18l3-8h14l-3 8z"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4M9 12h6M9 16h6"],
} as const;

function Icon({ kind }: { readonly kind: keyof typeof iconPaths }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
      aria-hidden
    >
      {iconPaths[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
