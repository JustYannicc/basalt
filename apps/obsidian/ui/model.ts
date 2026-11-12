/**
 * What the vault page shows, derived only from what the server has. Plugins before device
 * check-in leave `devices` null and history without times; the page then shows less, never an
 * empty or "connect" state for a vault that has synced.
 */

export interface ImportStatus {
  readonly state: "planning" | "ready" | "complete";
  readonly files: number;
  readonly confirmed: number;
  readonly omitted: number;
}

/** One caller's last sync, as the drive records it from ordinary sync calls. */
export interface Device {
  /** The caller's grant: the host's mcp-agents id. */
  readonly agent: string;
  readonly lastSyncAt: string;
  readonly lastHead: string;
}

export interface Devices {
  readonly head: string;
  readonly lastChangeAt: string | null;
  readonly devices: readonly Device[];
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
  | {
      readonly kind: "stuck";
      readonly confirmed: number;
      readonly files: number;
      readonly since: string | null;
    }
  | { readonly kind: "up-to-date"; readonly files: number | null }
  | { readonly kind: "saved"; readonly files: number | null };

/** A device that hasn't synced for this long during an unfinished import counts as stuck. */
export const stuckAfterMs = 10 * 60 * 1000;

export function vaultState(input: {
  readonly status: ImportStatus | null;
  /** Whether the vault's root lists anything. */
  readonly hasFiles: boolean;
  readonly latest: Version | null;
  readonly devices: Devices | null;
  readonly now: number;
}): VaultState {
  const { status, devices, latest, now } = input;
  const files = status === null ? null : status.confirmed + status.omitted;
  if (status !== null && status.state !== "complete") {
    const synced = (devices?.devices ?? [])
      .map((device) => Date.parse(device.lastSyncAt))
      .filter((time) => !Number.isNaN(time));
    const last = synced.length ? Math.max(...synced) : null;
    // Without check-ins there is no clock to judge by, so an unfinished import reads as moving.
    if (devices !== null && (last === null || now - last > stuckAfterMs))
      return {
        kind: "stuck",
        confirmed: status.confirmed,
        files: status.files,
        since: last === null ? null : new Date(last).toISOString(),
      };
    return { kind: "importing", confirmed: status.confirmed, files: status.files };
  }
  if (status === null && !input.hasFiles && latest === null) return { kind: "empty" };
  // Up to date only when every caller that synced holds the current head. Agents using the
  // tools may be among them; a lagging one only withholds "up to date", never claims it.
  if (devices === null || devices.devices.length === 0) return { kind: "saved", files };
  const current = devices.devices.every((device) => device.lastHead === devices.head);
  return { kind: current ? "up-to-date" : "saved", files };
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
