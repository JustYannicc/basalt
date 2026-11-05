import { StringDecoder } from "node:string_decoder";

const phases = new Set([
  "unknown",
  "module-load",
  "fixture",
  "environment",
  "registry",
  "framework",
  "server",
  "actors",
  "deploy",
  "inventory",
  "access",
  "oauth",
  "health",
  "mcp-keys",
  "mcp-connect",
  "tools",
  "browser",
  "paste-ui",
  "refresh",
  "report",
  "cleanup",
  "complete",
]);

const kinds = new Set([
  "timeout",
  "module-resolution",
  "assertion",
  "syntax",
  "type",
  "browser-launch",
  "unknown",
]);

function failureKind(text: string) {
  if (/browserType\.launch|Socket path too long|Failed to create socket directory/.test(text))
    return "browser-launch";
  if (/(?:Cannot find (?:package|module)|ModuleNotFound|ERR_MODULE_NOT_FOUND)/.test(text))
    return "module-resolution";
  if (/AssertionError/.test(text)) return "assertion";
  if (/SyntaxError/.test(text)) return "syntax";
  if (/TypeError/.test(text)) return "type";
}

/** CI receives fixed categories and source positions, never exception messages or payloads. */
export function awsFailureSummary({
  code,
  timedOut,
  stderr,
  phase,
  checks,
  kind: recordedKind,
  location: recordedLocation,
}: {
  code?: unknown;
  timedOut?: unknown;
  stderr?: unknown;
  phase?: unknown;
  checks?: unknown;
  kind?: unknown;
  location?: unknown;
}) {
  const text = typeof stderr === "string" ? stderr : "";
  const source =
    typeof recordedLocation === "string" &&
    /^e2e\/aws\/(runtime|oauth|browser|fixture)\.mjs:\d{1,6}(?::\d{1,6})?$/.test(recordedLocation)
      ? recordedLocation
      : undefined;
  const location =
    /(?:^|[\s(/])(?:[^\s()]*\/)?e2e\/aws\/(runtime|oauth|browser|fixture)\.mjs:(\d{1,6})(?::(\d{1,6}))?/.exec(
      text,
    );
  const detected = failureKind(text);
  const retained =
    typeof recordedKind === "string" && kinds.has(recordedKind) ? recordedKind : "unknown";
  const kind =
    timedOut === true
      ? "timeout"
      : (detected ?? (retained === "unknown" && phase === "browser" ? "browser-launch" : retained));
  return {
    phase:
      typeof phase === "string" && phases.has(phase)
        ? phase
        : kind === "module-resolution"
          ? "module-load"
          : "unknown",
    ...(typeof checks === "number" && Number.isSafeInteger(checks) && checks >= 0
      ? { checks }
      : {}),
    code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
    timedOut: timedOut === true,
    kind,
    ...(location
      ? {
          location: `e2e/aws/${location[1]}.mjs:${location[2]}${location[3] ? `:${location[3]}` : ""}`,
        }
      : source
        ? { location: source }
        : {}),
  };
}

type OutputStream = "stdout" | "stderr";

function outputRecord(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {}
  if (typeof value === "object" && value !== null) {
    if ("awsProofPhase" in value) {
      const summary = awsFailureSummary({
        phase: value.awsProofPhase,
        checks: "checks" in value ? value.checks : undefined,
      });
      if (summary.phase !== "unknown")
        return {
          kind: "phase",
          phase: summary.phase,
          ...(summary.checks === undefined ? {} : { checks: summary.checks }),
        };
    }
    if ("upstream" in value && value.upstream === "synthetic AWS MCP and OAuth service only") {
      const summary = awsFailureSummary({ checks: "checks" in value ? value.checks : undefined });
      return {
        kind: "completed",
        ...(summary.checks === undefined ? {} : { checks: summary.checks }),
      };
    }
  }
  const summary = awsFailureSummary({ stderr: text });
  return { kind: summary.kind, ...(summary.location ? { location: summary.location } : {}) };
}

/** Unknown output is represented by its category, never copied into an uploaded diagnostic. */
export class AwsOutputTail {
  private records: Array<
    ReturnType<typeof outputRecord> & { stream: OutputStream; elapsedMs: number }
  > = [];
  private truncated = false;
  private started = performance.now();
  private streams = {
    stdout: { decoder: new StringDecoder("utf8"), pending: "", discarded: false },
    stderr: { decoder: new StringDecoder("utf8"), pending: "", discarded: false },
  };

  push(stream: OutputStream, chunk: Buffer): void {
    this.consume(stream, this.streams[stream].decoder.write(chunk));
  }

  finish(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      this.consume(stream, this.streams[stream].decoder.end());
      if (this.streams[stream].pending || this.streams[stream].discarded) this.line(stream);
    }
  }

  text(): string {
    return JSON.stringify({ truncated: this.truncated, records: this.records });
  }

  private consume(stream: OutputStream, text: string): void {
    const state = this.streams[stream];
    let start = 0;
    do {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end === -1 ? undefined : end);
      if (!state.discarded) {
        state.pending += part;
        if (Buffer.byteLength(state.pending) > 4096) {
          state.pending = "";
          state.discarded = this.truncated = true;
        }
      }
      if (end === -1) break;
      this.line(stream);
      start = end + 1;
    } while (start < text.length);
  }

  private line(stream: OutputStream): void {
    const state = this.streams[stream];
    this.records.push({
      stream,
      elapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
      ...(state.discarded ? { kind: "omitted-line" } : outputRecord(state.pending)),
    });
    state.pending = "";
    state.discarded = false;
    while (Buffer.byteLength(this.text()) > 16 * 1024) {
      this.records.shift();
      this.truncated = true;
    }
  }
}
