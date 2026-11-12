import { useCallback, useEffect, useState } from "react";
import type { Entry, VaultApi } from "./api.ts";
import { noteTitle, sortEntries } from "./model.ts";

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
    <ul className="tree" role="tree" aria-label="Vault files">
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
      <li role="treeitem" aria-selected={selected === entry.path}>
        <button
          type="button"
          className={`row ${selected === entry.path ? "selected" : ""}`}
          style={indent}
          onClick={() => onSelect(entry.path)}
        >
          <span className="icon file" aria-hidden />
          <span className="label">
            {/\.md$/i.test(entry.name) ? noteTitle(entry.name) : entry.name}
          </span>
        </button>
      </li>
    );
  return (
    <li role="treeitem" aria-expanded={isOpen}>
      <button type="button" className="row" style={indent} onClick={() => toggle(entry.path)}>
        <span className={`icon ${isOpen ? "folder-open" : "folder"}`} aria-hidden />
        <span className="label">{entry.name}</span>
      </button>
      {isOpen && (
        <ul role="group">
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
