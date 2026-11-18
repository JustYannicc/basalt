import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { redactLogText } from "../../src/telemetry/log-redaction.ts";

export const connectionLogName = "connection.log";
const lineLength = 1024;
const appendFlags =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/**
 * Keeps the connection process's warnings on the device, so a tunnel failure leaves a trace.
 * Lines pass the shared credential redaction and are cut to 1,024 characters. The file rotates
 * before a write would pass `maxBytes`, to one previous copy. A failed write is dropped: keeping
 * the log must never stop the connection.
 */
export class ConnectionLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private pending = "";
  private dropping = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(path: string, maxBytes = 512 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  /** Raw process output: complete lines are kept, and a partial line waits for its end. */
  output(text: string) {
    const lines = (this.pending + text).split(/\r?\n/u);
    this.pending = lines.pop() ?? "";
    // The rest of a line that was already cut runs to its newline and is not kept.
    if (this.dropping) {
      if (lines.length === 0) {
        this.pending = "";
        return;
      }
      lines.shift();
      this.dropping = false;
    }
    if (this.pending.length > lineLength) {
      lines.push(this.pending);
      this.pending = "";
      this.dropping = true;
    }
    this.keep(lines);
  }

  /** A line the app writes about the process, such as its exit. */
  note(line: string) {
    this.keep([line]);
  }

  /** The process closed: its unfinished last line is kept before the closing note. */
  end(line: string) {
    if (this.pending && !this.dropping) this.keep([this.pending]);
    this.pending = "";
    this.dropping = false;
    this.keep([line]);
  }

  /** Resolves once every line accepted so far is written. */
  flushed(): Promise<void> {
    return this.queue;
  }

  private keep(lines: readonly string[]) {
    const at = new Date().toISOString();
    const text = lines
      .filter((line) => line.trim())
      .map((line) => `${at} ${redactLogText(line).slice(0, lineLength)}\n`)
      .join("");
    if (text) this.queue = this.queue.then(() => this.append(text));
  }

  private async append(text: string) {
    try {
      const bytes = Buffer.byteLength(text);
      const current = await lstat(this.path).catch(() => undefined);
      if (current?.isFile() && current.size > 0 && current.size + bytes > this.maxBytes)
        await rename(this.path, `${this.path}.1`);
      // Like the profile's other private files: never through a symlink, readable only by its owner.
      const handle = await open(this.path, appendFlags, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(text);
      } finally {
        await handle.close();
      }
    } catch {}
  }
}
