import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { redactLogText } from "../../src/telemetry/log-redaction.ts";

export const connectionLogName = "connection.log";
const lineLength = 1024;
const cutMark = " [cut]";
// O_NONBLOCK: a pipe at the path with no reader fails the open at once (ENXIO) instead of holding
// a threadpool thread, which process.exit would wait for. A regular file is unaffected.
const appendFlags =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/**
 * A longer line is cut before redaction, which is quadratic on long runs without spaces. The cut
 * drops the word it divides, back to the last space: a piece of a token is too short to be
 * recognised as one.
 */
function shorten(line: string) {
  const long = line.length > lineLength;
  const head = long ? line.slice(0, line.lastIndexOf(" ", lineLength - 1) + 1) : line;
  const text = redactLogText(head).trimEnd();
  if (!long && text.length <= lineLength) return text;
  const kept = text.slice(0, lineLength - cutMark.length).trimEnd();
  return kept ? kept + cutMark : cutMark.trim();
}

/**
 * Keeps the connection process's warnings on the device, so a tunnel failure leaves a trace.
 * Lines pass the shared credential redaction and are cut to 1,024 characters. The file rotates
 * before a line would take it past `maxBytes`, to one previous copy. A failed write is dropped:
 * keeping the log must never stop the connection.
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
    const kept = lines.filter((line) => line.trim()).map((line) => `${at} ${shorten(line)}\n`);
    if (kept.length) this.queue = this.queue.then(() => this.append(kept));
  }

  private async append(lines: readonly string[]) {
    try {
      const current = await lstat(this.path).catch(() => undefined);
      let size = current?.isFile() ? current.size : 0,
        batch = "";
      // Per line, not per read: a line is at most about 3 KiB, so neither file passes `maxBytes`.
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > this.maxBytes) {
          if (batch) await this.write(batch);
          await rename(this.path, `${this.path}.1`);
          size = 0;
          batch = "";
        }
        batch += line;
        size += bytes;
      }
      if (batch) await this.write(batch);
    } catch {}
  }

  private async write(text: string) {
    // Like the profile's other private files: never through a symlink, readable only by its owner.
    const handle = await open(this.path, appendFlags, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.write(text);
    } finally {
      await handle.close();
    }
  }
}
