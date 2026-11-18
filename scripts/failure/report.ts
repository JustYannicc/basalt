import { appendFile } from "node:fs/promises";
import { createError, defineErrorCatalog, EvlogError } from "evlog";
import { causeChain, causeLine, field, typeName, unreachable, type PublicCause } from "./cause.ts";
import { ChildProcessFailure } from "./child.ts";
import { publicText, redactCredentials } from "./redact.ts";

// evlog is installed for this directory only, so its error constructors are passed on from here.
export { createError, defineErrorCatalog, EvlogError };

/**
 * The one place a release or operations failure becomes text for a person: the command's error
 * line and the job's step summary. Every failure leaves as an evlog structured error with what
 * happened, why, how to fix it and the cause chain, all of it safe for a public log.
 */
const catalog = defineErrorCatalog("release", {
  CHILD_FAILED: {
    message: ({ what }: { what: string }) => what,
    why: "A command this step ran did not succeed. Its last output lines are below.",
    fix: "Fix what the output names and rerun this step. If the output is empty, run the command alone to see it fail.",
  },
  UNREACHABLE: {
    message: ({ what }: { what: string }) => what,
    fix: "The service was not reached, so nothing changed there. Rerun; if it repeats, check the service's status.",
  },
  REQUEST_FAILED: {
    message: ({ what }: { what: string }) => what,
    fix: "The request failed the same way it will on a rerun. Fix the call or the response handling named in the cause chain.",
  },
  UNEXPECTED: {
    message: ({ what }: { what: string }) => what,
    fix: "This failure has no written fix yet. Follow the cause chain to the step that raised it.",
  },
});

export interface FailureReport {
  /** Message, code, why, fix and link, with a cause chain that holds public text only. */
  error: EvlogError;
  /** The same chain, outermost first. */
  causes: PublicCause[];
  /** Named fields of a refusal and its violations, one line each. */
  details: string[];
  /** The last output lines of a failed command, already public. */
  tail?: string;
}

const subjects = [
  "resource",
  "check",
  "rule",
  "script",
  "reason",
  "route",
  "method",
  "path",
  "field",
  "value",
];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

/** Rebuilt from public causes, so nothing that prints the error can reach the original text. */
function publicError(causes: PublicCause[]): Error | undefined {
  let inner: Error | undefined;
  for (const cause of causes.toReversed()) {
    inner = new Error(causeLine(cause), inner ? { cause: inner } : {});
    inner.name = cause.type;
    delete inner.stack;
  }
  return inner;
}

function find<A>(error: unknown, match: (value: unknown) => A | undefined): A | undefined {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current);) {
    seen.add(current);
    const found = match(current);
    if (found !== undefined) return found;
    current = field(field(current, "reason"), "cause") ?? field(current, "cause");
  }
  return undefined;
}

/** Any failure as a structured error. Refusals keep the why and fix their author wrote. */
export function structuredFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): FailureReport {
  const own = (value: string) => redactCredentials(value, environment).slice(0, 2048);
  const causes = causeChain(error, environment).slice(1);
  const cause = publicError(causes);
  const child = find(error, (value) => (value instanceof ChildProcessFailure ? value : undefined));
  const tail = child?.report.tail ? { tail: child.report.tail } : {};

  if (EvlogError.isEvlogError(error)) return { error, causes, details: [], ...tail };

  const details: string[] = [];
  const violations = field(error, "violations");
  const listed = Array.isArray(violations)
    ? violations.filter((value) => text(field(value, "why")) && text(field(value, "fix")))
    : [];
  const why = text(field(error, "why")) ?? text(field(listed[0], "why"));
  const fix = text(field(error, "fix")) ?? text(field(listed[0], "fix"));
  if (why && fix) {
    // Written by this repository for the log: credentials are still removed, the wording is kept.
    for (const key of subjects) {
      const value = field(error, key);
      if (typeof value === "string" || typeof value === "number")
        details.push(`${key}: ${own(String(value))}`);
    }
    const detail = field(error, "detail");
    if (detail !== undefined) details.push(`detail: ${own(JSON.stringify(detail))}`);
    for (const violation of listed) {
      const subject = ["rule", "fqn", "type", "action"]
        .map((key) => text(field(violation, key)))
        .filter(Boolean)
        .join(" ");
      details.push(
        `violation: ${own(subject)}`,
        ...(Array.isArray(field(violation, "change"))
          ? (field(violation, "change") as unknown[]).map(
              (line) => `  change: ${own(String(line))}`,
            )
          : []),
        `  why: ${own(String(field(violation, "why")))}`,
        `  fix: ${own(String(field(violation, "fix")))}`,
      );
    }
    const many = listed.length > 1;
    const link = text(field(error, "link"));
    const type = typeName(error);
    return {
      error: createError({
        ...(type === "unknown" ? {} : { code: type }),
        message: many
          ? `${listed.length} violations refused this step`
          : own(text(field(error, "message"))?.split("\n")[0] ?? why),
        why: many ? "Each violation below gives its own reason." : own(why),
        fix: many ? "Each violation below names its fix." : own(fix),
        ...(link && /^https:\/\/[^\s]+$/u.test(link) ? { link } : {}),
        ...(cause ? { cause } : {}),
      }),
      causes,
      details,
      ...tail,
    };
  }

  const options = cause ? { cause } : {};
  if (child)
    return {
      error: catalog.CHILD_FAILED({ what: child.message.split("\n")[0]!, ...options }),
      causes,
      details,
      ...tail,
    };
  const all = causeChain(error, environment);
  const top = all[0]!;
  const inner = all.at(-1)!;
  const message = text(field(error, "message"));
  const what =
    top.type === "HttpClientError" || top.request
      ? causeLine({ ...top, message: undefined })
      : [
          top.type === "unknown" ? "A failure of an unlisted type" : top.type,
          top.message ?? (message && publicText(message, environment)),
        ]
          .filter(Boolean)
          .join(": ");
  const reason =
    all.length > 1
      ? `It was caused by ${causeLine(inner)}.`
      : "It carries no cause, so its message is all that is known.";
  // No status means no answer: with a network code the request never reached the service.
  const unreached =
    all.every((entry) => entry.status === undefined) &&
    all.some((entry) => entry.code !== undefined && unreachable.has(entry.code));
  const kind = unreached
    ? catalog.UNREACHABLE
    : all.some((entry) => entry.request || entry.type === "HttpClientError")
      ? catalog.REQUEST_FAILED
      : catalog.UNEXPECTED;
  return { error: kind({ what, why: reason, ...options }), causes, details };
}

/** Plain lines for a terminal or an Actions log. */
export function failureText(report: FailureReport, title: string): string {
  const { error } = report;
  return [
    `${title}: ${error.message}`,
    ...(error.code ? [`  code: ${error.code}`] : []),
    ...(error.why ? [`  why: ${error.why}`] : []),
    ...(error.fix ? [`  fix: ${error.fix}`] : []),
    ...(error.link ? [`  link: ${error.link}`] : []),
    ...report.details.map((line) => `  ${line}`),
    ...report.causes.map((cause, index) => `  cause ${index + 1}: ${causeLine(cause)}`),
    ...(report.tail
      ? [
          "  last output lines, credentials removed:",
          ...report.tail.split("\n").map((line) => `    ${line}`),
        ]
      : []),
  ].join("\n");
}

const inline = (value: string) =>
  value.replaceAll("<", "&lt;").replaceAll("`", "&#96;").replaceAll("|", "&#124;");

/** The same failure as Markdown for the step summary. */
export function failureSummary(report: FailureReport, title: string): string {
  const { error } = report;
  return [
    `## ${inline(title)}`,
    "",
    `**${inline(error.message)}**`,
    "",
    ...(error.why ? [`- **Why:** ${inline(error.why)}`] : []),
    ...(error.fix ? [`- **Fix:** ${inline(error.fix)}`] : []),
    ...(error.link ? [`- **More:** ${error.link}`] : []),
    ...(error.code ? [`- **Code:** ${inline(error.code)}`] : []),
    ...report.causes.map((cause, index) => `- **Cause ${index + 1}:** ${inline(causeLine(cause))}`),
    ...(report.details.length
      ? ["", "```text", ...report.details.map((line) => line.replaceAll("```", "'''")), "```"]
      : []),
    ...(report.tail
      ? [
          "",
          "Last output lines, credentials removed:",
          "",
          "```text",
          report.tail.replaceAll("```", "'''"),
          "```",
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * Writes the failure where a person looks: plain lines and one `::error` annotation on the error
 * output, and a section in the step summary when the job has one. Returns the structured error.
 */
export async function reportFailure(
  error: unknown,
  options: {
    /** What stopped, such as "Release stopped". */
    title?: string;
    summaryPath?: string | undefined;
    write?: (line: string) => void;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<FailureReport> {
  const title = options.title ?? "Failed";
  const write = options.write ?? ((line: string) => console.error(line));
  const report = structuredFailure(error, options.environment);
  const lines = failureText(report, title);
  write(lines);
  write(
    `::error title=${title.replace(/[\r\n:,%]/gu, " ")}::${lines.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  if (options.summaryPath) await appendFile(options.summaryPath, failureSummary(report, title));
  return report;
}
