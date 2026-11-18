import { appendFile } from "node:fs/promises";
import { createError, defineErrorCatalog, EvlogError } from "evlog";
import { causeLine } from "./cause.ts";
import { publicGuidance } from "./redact.ts";
import { failures, structuredFailure, type FailureReport } from "./structure.ts";

/**
 * The one place a release or operations failure becomes text for a person: the command's error
 * output and, where the caller asks, the job's step summary.
 */

// evlog is installed for this directory only, so its error constructors are passed on from here.
export { createError, defineErrorCatalog, EvlogError, structuredFailure, type FailureReport };

/** Plain lines for a terminal or an Actions log. */
export function failureText(report: FailureReport, title: string): string {
  const { error } = report;
  return [
    `${publicGuidance(title)}: ${error.message}`,
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

/** The same report for the step summary, as text so nothing in it is read as Markdown. */
export const failureSummary = (report: FailureReport, title: string): string =>
  `## ${publicGuidance(title).replace(/[<>`*_[\]|#]/gu, " ")}\n\n\`\`\`text\n${failureText(report, title).replaceAll("```", "'''")}\n\`\`\`\n`;

/**
 * Writes the failure where a person looks: plain lines and one `::error` annotation on the error
 * output, and a section in the step summary when a path is given. Returns the report. It never
 * throws: a failure to describe a failure must not hide that there was one.
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
  let report: FailureReport;
  try {
    report = structuredFailure(error, options.environment);
  } catch {
    report = {
      error: failures.UNEXPECTED({
        what: "The failure could not be described",
        why: "Reading the failure raised an error of its own.",
      }),
      causes: [],
      details: [],
    };
  }
  const lines = failureText(report, title);
  write(lines);
  write(
    `::error title=${publicGuidance(title).replace(/[\r\n:,%]/gu, " ")}::${lines.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  if (options.summaryPath)
    await appendFile(options.summaryPath, failureSummary(report, title)).catch(() =>
      write("The step summary could not be written."),
    );
  return report;
}
