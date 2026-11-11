import type { AttachmentSummary } from "./attachments.ts";
import type { DeviceStatus } from "./controller.ts";

export type Tone = "ok" | "busy" | "warn" | "error" | "muted";

export interface StatusView {
  tone: Tone;
  /** Short line for the status bar and the settings heading. */
  title: string;
  detail: string;
  /** True only when every local file is in Basalt and nothing waits on a person. */
  complete: boolean;
}

export interface StatusInput {
  status: DeviceStatus;
  attachments: AttachmentSummary;
  /** Files kept in the recovery folder because they were removed elsewhere. */
  recovered: number;
  lastSynced: number | null;
  now: number;
  /** Startup failure (unreadable saved state, missing API). */
  failure: string | null;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

type Initial = NonNullable<DeviceStatus["initial"]>;

/**
 * The one-time import's own progress. `confirmed` can briefly outrun `files` when source files
 * removed mid-import were already confirmed, so the shown count never passes the total.
 */
const importProgress = (initial: Initial) =>
  initial.phase === "planning"
    ? `Preparing the import of ${plural(initial.files, "file")} (${formatBytes(initial.bytes)})`
    : `${Math.min(initial.confirmed, initial.files).toLocaleString("en-US")} of ${plural(initial.files, "file")} imported (${formatBytes(initial.bytes)} in all)`;

const queuedText = (queued: number) =>
  queued > 0 ? `${plural(queued, "change")} waiting on this device.` : "Nothing waiting to upload.";

export function describeStatus(input: StatusInput): StatusView {
  const { status, attachments } = input;
  // The controller's own unsupported list counts even if a port forgets to forward it.
  const unsynced = new Set([
    ...status.unsupported,
    ...attachments.unsynced,
    ...attachments.failed.map((file) => file.path),
  ]).size;
  const view = (tone: Tone, title: string, detail: string, complete = false): StatusView => ({
    tone,
    title,
    detail,
    complete,
  });

  if (input.failure) return view("error", "Sync can't start", input.failure);
  if (status.state === "disconnected")
    return view("muted", "Not connected", "Connect this vault from Signalbox.");
  if (status.state === "authorizing")
    return view("busy", "Waiting for approval", "Approve this device in your browser.");
  // Present only while the first import is unfinished; it is never "synced" until it is gone.
  const initial = status.initial;
  if (status.state === "paused")
    return initial
      ? view(
          "muted",
          "Import paused",
          `${importProgress(initial)}. It continues where it stopped when you resume.`,
        )
      : view(
          "muted",
          "Sync paused",
          `${queuedText(status.queued)} Edits stay here until you resume.`,
        );
  if (status.state === "syncing" && initial)
    return view(
      "busy",
      initial.phase === "planning" ? "Preparing the import" : "Importing this vault",
      `${importProgress(initial)}. Keep Obsidian open; it resumes if interrupted.`,
    );
  if (status.state === "syncing")
    return status.head === null
      ? view(
          "busy",
          "Importing this vault",
          "Keep Obsidian open until the first import finishes. It resumes if interrupted.",
        )
      : view("busy", "Syncing", queuedText(status.queued));
  if (status.state === "offline" || status.error)
    return view(
      "error",
      /reconnect|connect again/iu.test(status.error ?? "") ? "Device access ended" : "Sync stopped",
      `${status.error ?? "Sync failed."} ${
        initial
          ? `${importProgress(initial)} so far; it resumes from there.`
          : queuedText(status.queued)
      }`,
    );

  const needs: string[] = [];
  if (status.conflicts > 0) needs.push(`${plural(status.conflicts, "conflict")} to review`);
  if (unsynced > 0) needs.push(`${plural(unsynced, "file")} not in Signalbox yet`);
  if (input.recovered > 0) needs.push(`${plural(input.recovered, "recovered file")} to check`);
  if (needs.length) {
    const title = status.conflicts > 0 ? "Needs a choice" : "Needs attention";
    return view(
      "warn",
      title,
      initial
        ? `${needs.join(", ")}. Import not finished: ${importProgress(initial)}.`
        : status.queued > 0
          ? `${needs.join(", ")}. ${plural(status.queued, "change")} still to sync.`
          : `${needs.join(", ")}. Everything else is synced.`,
    );
  }
  if (initial)
    return view(
      "busy",
      "Import not finished",
      `${importProgress(initial)}. It continues the next time sync runs; keep Obsidian open.`,
    );
  if (attachments.downloading > 0)
    return view(
      "busy",
      "Downloading attachments",
      `${plural(attachments.downloading, "file")} left.`,
    );
  // Edits wait for a checkpoint, so "Synced" would be a lie while any are waiting.
  if (status.queued > 0)
    return view(
      "muted",
      `${plural(status.queued, "change")} to sync`,
      "They go to Signalbox after a few minutes without edits, when you leave Obsidian, or when you choose Sync now.",
    );
  const when = input.lastSynced === null ? "" : ` ${ago(input.lastSynced, input.now)}`;
  return view("ok", `Synced${when}`, queuedText(0), true);
}
