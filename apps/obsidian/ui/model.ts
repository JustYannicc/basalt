/**
 * What the vault page shows, derived only from what the server has. Plugins before dated
 * history leave versions without times; the page then shows less, never an empty or "connect"
 * state for a vault that has synced. Device sync records don't decide anything here: the drive
 * can't yet tell a device's sync from an agent's call of the same shape, and a false "needs
 * attention" costs more than a missing "up to date". Devices show on Accounts, joined to grants.
 */

export interface ImportStatus {
  readonly state: "planning" | "ready" | "complete";
  readonly files: number;
  readonly confirmed: number;
  readonly omitted: number;
}

export interface Version {
  readonly oid: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** Absent before the server recorded commit times. */
  readonly time?: string;
}

export type VaultState =
  | { readonly kind: "empty" }
  | { readonly kind: "importing"; readonly confirmed: number; readonly files: number }
  | { readonly kind: "saved" };

export function vaultState(input: {
  readonly status: ImportStatus | null;
  /** Whether the vault's root lists anything. */
  readonly hasFiles: boolean;
  readonly latest: Version | null;
}): VaultState {
  const { status, latest } = input;
  if (status !== null && status.state !== "complete")
    return { kind: "importing", confirmed: status.confirmed, files: status.files };
  if (status === null && !input.hasFiles && latest === null) return { kind: "empty" };
  return { kind: "saved" };
}

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

/** "just now", "4 minutes ago", "3 hours ago", then a date. */
export function ago(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < minute) return "just now";
  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function when(iso: string): string {
  const time = new Date(iso);
  return time.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const isNote = (path: string) => /\.md$/i.test(path);
export const noteTitle = (name: string) => name.replace(/\.md$/i, "");

/** Quartz Explorer's order: folders first, then names, case-insensitively and numerically. */
export const sortEntries = <
  T extends { readonly kind: "file" | "directory"; readonly name: string },
>(
  entries: readonly T[],
): T[] =>
  [...entries].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
