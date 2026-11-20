import { safeJson } from "./safe-json.ts";

/**
 * What a stopped run says in public (the repository, its logs, step summaries and artifacts are
 * public) and what it keeps private. Public: the tagged reason in our own vocabulary, the error
 * class, and the key paths a plan refusal names. Private: names, ids, paths, values and raw
 * messages, which can carry hosts or account ids.
 */
export interface FailureReport {
  readonly publicText: string;
  readonly detail: string;
}

const PUBLIC_FIELDS = ["check", "rule", "field", "exit", "why", "fix"] as const;
const PRIVATE_FIELDS = ["resource", "script", "method", "path", "value"] as const;
const CHAIN = ["cause", "reason", "error", "defect", "failures", "reasons", "issue"] as const;

/**
 * Records keyed by data rather than by names in our source: an API token policy's `resources`
 * (Cloudflare resource names that carry account and zone ids) and observability `headers`. A key's
 * own dots split it into pieces that look like names, and the line cannot say where the key ends,
 * so everything after such a record prints as one `{key}`. A new record keyed by data belongs here.
 */
const DATA_KEYED = new Set(["resources", "headers"]);
const NAME = /^\$?[A-Za-z_][A-Za-z0-9_]*$/u;
const INDEX = /^(?:0|[1-9][0-9]{0,3})$/u;
/** Account, zone and namespace ids, hashes and digests are hex runs, which a name never holds. */
const HEX_ID = /[A-Fa-f0-9]{16,}/u;
const KEYS_PER_VIOLATION = 8;

/**
 * The key path of a change line (`path: before -> after`, see `propChanges`), never its values:
 * anything that is not one of our names or an array index prints as `{key}`.
 */
const keyPath = (line: string) => {
  const end = line.indexOf(": ");
  if (end < 0) return "{key}";
  const segments = line.slice(0, end).split(".");
  const printed: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const named = (NAME.test(segment) && !HEX_ID.test(segment)) || INDEX.test(segment);
    const shown = named ? segment : "{key}";
    if (shown !== "{key}" || printed.at(-1) !== "{key}") printed.push(shown);
    if (DATA_KEYED.has(segment) && index < segments.length - 1) {
      printed.push("{key}");
      break;
    }
  }
  return printed.join(".");
};

const keyPaths = (change: unknown) => {
  const lines = Array.isArray(change) ? change.filter((line) => typeof line === "string") : [];
  const paths = [...new Set(lines.map(keyPath))];
  const more = paths.length - KEYS_PER_VIOLATION;
  const shown = paths.slice(0, KEYS_PER_VIOLATION).join(",");
  return paths.length ? `[${shown}${more > 0 ? `,+${more} more` : ""}]` : "";
};

const errorClass = (error: unknown) => {
  if (error && typeof error === "object") {
    const tag = (error as { _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
    return error.constructor?.name ?? "object";
  }
  return typeof error;
};

const fields = (record: Record<string, unknown>, keys: readonly string[]) =>
  keys
    .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
    .map((key) => `${key}=${String(record[key])}`);

/** Where the run was: its phase, and the resources Alchemy had in hand, by the names in our source. */
export interface FailureContext {
  readonly phase: string;
  readonly resources: ReadonlyArray<{ readonly fqn: string; readonly type: string }>;
}

/**
 * Follows Alchemy's own progress events: a resource that reported `fail`, else those still in
 * flight. Logical ids and types are names from our own public source, safe to print.
 */
export function progressTracker() {
  let phase = "start";
  const inFlight = new Map<string, string>();
  const failed = new Map<string, string>();
  return {
    setPhase(next: string) {
      phase = next;
    },
    track(event: unknown) {
      if (!event || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      if (record._tag !== "apply.resource.status" || typeof record.fqn !== "string") return;
      const type = typeof record.type === "string" ? record.type : "resource";
      const status = String(record.status);
      if (status === "fail") failed.set(record.fqn, type);
      else if (["creating", "updating", "deleting", "replacing", "running"].includes(status))
        inFlight.set(record.fqn, type);
      else inFlight.delete(record.fqn);
    },
    context(): FailureContext {
      const resources = failed.size ? failed : inFlight;
      return { phase, resources: [...resources].map(([fqn, type]) => ({ fqn, type })) };
    },
  };
}

/** The error's class and a kind a reader can act on, from tags, names and HTTP statuses only. */
export function errorKind(error: unknown) {
  const names: string[] = [];
  let status: number | undefined;
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 10) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record._tag === "string") names.push(record._tag);
    else if (value instanceof Error && value.name) names.push(value.name);
    for (const key of ["status", "statusCode"])
      if (typeof record[key] === "number" && status === undefined) status = record[key] as number;
    for (const key of CHAIN)
      if (key in record) {
        const next = record[key];
        if (Array.isArray(next)) for (const item of next) visit(item, depth + 1);
        else visit(next, depth + 1);
      }
  };
  visit(error, 0);
  const all = names.join(" ");
  const kind = /Timeout/u.test(all)
    ? "timeout"
    : /Schema|Parse|Decode|SyntaxError/u.test(all)
      ? "decode"
      : status === 404
        ? "not found"
        : status === 409
          ? "conflict"
          : status === 401 || status === 403 || /Refus/u.test(all)
            ? "refused"
            : status === 429
              ? "throttled"
              : status !== undefined && status >= 500
                ? "server error"
                : "failed";
  // The most specific name in the chain: outer wrappers are often a plain Error.
  const generic = new Set(["Error", "UnknownException", "UnknownError", "FiberFailure"]);
  return {
    errorClass: names.find((name) => !generic.has(name)) ?? names[0] ?? errorClass(error),
    kind,
    ...(status === undefined ? {} : { status }),
  };
}

const where = (context?: FailureContext) => {
  if (!context) return "";
  const at = context.resources.map(({ fqn, type }) => `${fqn} (${type})`).join(", ");
  return ` in ${context.phase}${at ? ` at ${at}` : ""}`;
};

export function failureReport(error: unknown, context?: FailureContext): FailureReport {
  const publicLines: string[] = [];
  const detailLines: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 10) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      typeof record._tag === "string" &&
      /Refus|Refused|Failed|Unavailable|Possible|AfterApply/u.test(record._tag)
    ) {
      const violations = Array.isArray(record.violations)
        ? (record.violations as Array<Record<string, unknown>>)
        : [];
      const remaining = Array.isArray(record.remaining)
        ? (record.remaining as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      // The full change lines carry values, so they stay in the sealed detail below.
      const rules = violations
        .map(
          (violation) =>
            `${String(violation.rule)}@${String(violation.fqn)}${keyPaths(violation.change)}`,
        )
        .join(",");
      publicLines.push(
        [
          record._tag + ":",
          ...fields(record, PUBLIC_FIELDS),
          ...(rules ? [`rules=${rules}`] : []),
          ...(remaining.length ? [`remaining=${remaining.join("; ")}`] : []),
        ]
          .join(" ")
          .trim(),
      );
      detailLines.push(
        [
          record._tag + ":",
          ...fields(record, [...PRIVATE_FIELDS, ...PUBLIC_FIELDS]),
          ...(record.detail ? [`detail=${safeJson(record.detail)}`] : []),
          ...(violations.length ? [`violations=${safeJson(violations)}`] : []),
        ].join(" "),
      );
    }
    for (const key of CHAIN)
      if (key in record) {
        const next = record[key];
        if (Array.isArray(next)) for (const item of next) visit(item, depth + 1);
        else visit(next, depth + 1);
      }
  };
  visit(error, 0);
  // Every message along the chain, for the private detail only.
  const messages: string[] = [];
  const read = new Set<unknown>();
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || read.has(value) || depth > 10) return;
    read.add(value);
    if (value instanceof Error) messages.push(`${value.name}: ${value.message}`);
    for (const key of CHAIN)
      if (key in (value as Record<string, unknown>)) {
        const next = (value as Record<string, unknown>)[key];
        if (Array.isArray(next)) for (const item of next) collect(item, depth + 1);
        else collect(next, depth + 1);
      }
  };
  collect(error, 0);
  const message = messages.length ? messages.join("\n") : safeJson(error);
  const { errorClass: name, kind, status } = errorKind(error);
  const head = `Release stopped${where(context)}: ${name} (${kind}${status === undefined ? "" : `, HTTP ${status}`})`;
  return publicLines.length
    ? {
        publicText: `${head}\n${publicLines.map((line) => `- ${line}`).join("\n")}`,
        detail: `${head}\n${detailLines.map((line) => `- ${line}`).join("\n")}\n${message}`,
      }
    : {
        publicText: `${head}. The message is in the sealed detail.`,
        detail: `${head}: ${message}`,
      };
}
