import { appendFile, rename, stat } from "node:fs/promises";
import { redactLogText } from "../../src/telemetry/log-redaction.ts";

export const connectionLogName = "connection.log";
const lineBytes = 1024;

/**
 * Keeps the connection process's warnings on the device, so a tunnel failure leaves a trace.
 * Lines pass the shared credential redaction and are cut to 1 KiB; the file rotates to one
 * previous copy, so the folder never holds more than twice `maxBytes`. A failed write is dropped:
 * keeping the log must never stop the connection.
 */
export class ConnectionLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private size: number | undefined;
  private pending = "";
  private queue: Promise<void> = Promise.resolve();
  constructor(path: string, maxBytes = 512 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  /** Raw process output: complete lines are kept, and a partial line waits for its end. */
  output(text: string) {
    const lines = (this.pending + text).split(/\r?\n/u);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > lineBytes) {
      lines.push(this.pending);
      this.pending = "";
    }
    this.keep(lines);
  }

  /** A line the app writes about the process, such as its exit. */
  note(line: string) {
    this.keep([line]);
  }

  /** Resolves once every line accepted so far is written. */
  flushed(): Promise<void> {
    if (this.pending) {
      this.keep([this.pending]);
      this.pending = "";
    }
    return this.queue;
  }

  private keep(lines: readonly string[]) {
    const at = new Date().toISOString();
    const text = lines
      .filter((line) => line.trim())
      .map((line) => `${at} ${redactLogText(line).slice(0, lineBytes)}\n`)
      .join("");
    if (text) this.queue = this.queue.then(() => this.append(text));
  }

  private async append(text: string) {
    try {
      this.size ??= await stat(this.path).then(
        (value) => value.size,
        () => 0,
      );
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await rename(this.path, `${this.path}.1`);
        this.size = 0;
      }
      await appendFile(this.path, text, { mode: 0o600 });
      this.size += bytes;
    } catch {
      this.size = undefined;
    }
  }
}
