import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClassificationReport, Evidence } from "./types.ts";

export const releaseUpdateLabel = "release-update";
export const manualReleaseLabel = "manual-release";
export const databaseChangeLabel = "database-change";
export const workflowIdentityLabel = "workflow-identity-change";
export const machineRiskLabels = [manualReleaseLabel, databaseChangeLabel, workflowIdentityLabel] as const;

const safePreparationFailure = "Candidate preparation failed. See the Release updates workflow run for details.";
const publicEvidenceReasons = new Map([
  ["Home may change GORM AutoMigrate through model types or call sites; no source proof excludes it", "Home migration impact is unknown without source proof"],
  ["node release metadata or binaries changed without a source commit change", "Node release metadata or binaries changed without a source commit change"],
  ["runtime source changed without a database compatibility proof", "Runtime source changed without a database compatibility proof"],
  ["source comparison incomplete", "Source comparison is incomplete"],
  ["runtime source changed outside a proven database/workflow exclusion", "Runtime source changed outside a proven database or workflow exclusion"],
  ["changed patch has no tracking record", "A changed patch has no tracking record"],
]);

const sectionStart = "<!-- basalt-release-safety:start -->";
const sectionEnd = "<!-- basalt-release-safety:end -->";

export type ManualHoldOwnership = "machine" | "human" | "unknown" | "none";
export type LabelPlan = { labels: string[]; managedRiskLabels: string[]; added: string[]; removed: string[] };

export type MetadataInput = {
  currentLabels: string[];
  existingBody: string;
  report: ClassificationReport;
  manualHoldOwnership: ManualHoldOwnership;
};

export type MetadataPlan = LabelPlan & { body: string };

export function requiredRiskLabels(report: ClassificationReport): string[] {
  const labels = report.databaseChanged || report.workflowChanged ? [manualReleaseLabel] : [];
  if (report.databaseChanged) labels.push(databaseChangeLabel);
  if (report.workflowChanged) labels.push(workflowIdentityLabel);
  return labels;
}

export function reconcileLabels(
  currentLabels: string[],
  previouslyManagedRiskLabels: string[],
  report: ClassificationReport,
  manualHoldOwnership: ManualHoldOwnership,
): LabelPlan {
  const current = new Set(currentLabels);
  const added: string[] = [];
  if (!current.has(releaseUpdateLabel)) added.push(releaseUpdateLabel);
  current.add(releaseUpdateLabel);
  const required = new Set(requiredRiskLabels(report));
  const managed = new Set(previouslyManagedRiskLabels.filter((label) => machineRiskLabels.includes(label as typeof machineRiskLabels[number])));
  const removed: string[] = [];

  for (const label of managed) {
    if (required.has(label)) continue;
    if (label === manualReleaseLabel && manualHoldOwnership !== "machine") continue;
    if (current.delete(label)) removed.push(label);
  }
  for (const label of required) {
    if (!current.has(label)) added.push(label);
    current.add(label);
  }
  const managedRiskLabels = [...required].filter((label) => label !== manualReleaseLabel || manualHoldOwnership !== "human");
  return { labels: [...current].sort(), managedRiskLabels: managedRiskLabels.sort(), added: added.sort(), removed: removed.sort() };
}

export function safetySection(
  report: ClassificationReport,
  managedRiskLabels: string[],
  manualHoldOwnership: ManualHoldOwnership,
): string {
  const lines = [
    sectionStart,
    "### Automated release safety",
    `Base: \`${report.base.gitCommit}\``,
    `Candidate: \`${report.candidate.gitCommit}\``,
    `Database change: ${formatEvidence(report.evidence.database)}`,
    `Workflow identity change: ${formatEvidence(report.evidence.workflow)}`,
    `Machine-managed risk labels: ${managedRiskLabels.length ? managedRiskLabels.join(", ") : "none"}`,
  ];
  if (manualHoldOwnership === "human") lines.push("A maintainer has a manual release hold.");
  else if (manualHoldOwnership === "unknown") lines.push("A manual release hold is retained because its owner is unknown.");
  lines.push(sectionEnd);
  return lines.join("\n");
}

export function updateSafetySection(
  body: string,
  report: ClassificationReport,
  managedRiskLabels: string[],
  manualHoldOwnership: ManualHoldOwnership,
): string {
  const section = safetySection(report, managedRiskLabels, manualHoldOwnership);
  const startCount = body.split(sectionStart).length - 1;
  const endCount = body.split(sectionEnd).length - 1;
  if (startCount !== endCount || startCount > 1) throw new Error("Release safety section markers are invalid");
  if (startCount === 1) {
    const start = body.indexOf(sectionStart);
    const end = body.indexOf(sectionEnd) + sectionEnd.length;
    return `${body.slice(0, start)}${section}${body.slice(end)}`;
  }
  return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${section}\n`;
}

export function reconcileMetadata(input: MetadataInput): MetadataPlan {
  const previous = managedRiskLabelsInBody(input.existingBody);
  const plan = reconcileLabels(input.currentLabels, previous, input.report, input.manualHoldOwnership);
  return {
    ...plan,
    body: updateSafetySection(input.existingBody, input.report, plan.managedRiskLabels, input.manualHoldOwnership),
  };
}

export function managedRiskLabelsInBody(body: string): string[] {
  const startCount = body.split(sectionStart).length - 1;
  const endCount = body.split(sectionEnd).length - 1;
  if (startCount !== endCount || startCount > 1) throw new Error("Release safety section markers are invalid");
  if (!startCount) return [];
  const section = body.slice(body.indexOf(sectionStart), body.indexOf(sectionEnd) + sectionEnd.length);
  const line = /^Machine-managed risk labels: (.+)$/m.exec(section)?.[1];
  if (!line || line === "none") return [];
  const labels = line.split(", ");
  if (labels.some((label) => !machineRiskLabels.includes(label as typeof machineRiskLabels[number])))
    throw new Error("Release safety section has unknown managed labels");
  return labels;
}

function formatEvidence(evidence: Evidence): string {
  const state = evidence.state === "unchanged" ? "clear" : evidence.state;
  const allPaths = [...new Set(evidence.sources.flatMap((source) => source.changedPaths))].sort();
  const paths = allPaths.filter(isPublicRepoPath);
  const reasons = [...new Set(evidence.sources.map((source) => source.reason).filter((value): value is string => value !== undefined))]
    .map((reason) => publicEvidenceReasons.get(reason))
    .filter((reason): reason is string => reason !== undefined);
  const withheld = paths.length !== allPaths.length || evidence.sources.some((source) => source.reason !== undefined && !publicEvidenceReasons.has(source.reason));
  const detail = [
    state,
    paths.length ? `paths: ${paths.map(code).join(", ")}` : "",
    reasons.length ? reasons.join("; ") : "",
    withheld ? "additional evidence details omitted" : "",
  ]
    .filter(Boolean).join("; ");
  return detail || "clear";
}

export function sanitizePublicPreparationFailure(failure: unknown): string | undefined {
  return failure === undefined || failure === null || failure === false ? undefined : safePreparationFailure;
}

function isPublicRepoPath(value: string): boolean {
  if (value.length > 240 || !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)) return false;
  return value.split("/").every((part) => part !== "." && part !== "..");
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as MetadataInput;
    const output = reconcileMetadata(input);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
