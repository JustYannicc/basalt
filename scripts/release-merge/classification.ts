export type ImpactState = "unchanged" | "changed" | "unknown";

export type ClassificationEvidence = {
  state: ImpactState;
  sources: Array<{
    name: string;
    state: ImpactState;
    base: string;
    candidate: string;
    changedPaths: string[];
    reason?: string;
  }>;
};

export type ReleaseClassification = {
  schemaVersion: 1;
  base: { gitCommit: string };
  candidate: { gitCommit: string };
  databaseChanged: boolean;
  workflowChanged: boolean;
  evidence: { database: ClassificationEvidence; workflow: ClassificationEvidence };
};

export type ClassificationDecision = {
  databaseChanged: boolean;
  workflowChanged: boolean;
  labels: string[];
};

export const RELEASE_CLASSIFICATION_LABELS = Object.freeze({
  manual: "manual-release",
  database: "database-change",
  workflow: "workflow-identity-change",
});

const SHA = /^[a-f0-9]{40}$/i;

export function validateReleaseClassification(
  value: unknown,
  expected: { base: string; candidate: string },
): { decision?: ClassificationDecision; reasons: string[] } {
  if (!isRecord(value)) return { reasons: ["classifier report is not an object"] };
  if (!hasKeys(value, ["schemaVersion", "base", "candidate", "databaseChanged", "workflowChanged", "evidence"]))
    return { reasons: ["classifier report has unexpected or missing fields"] };
  if (value.schemaVersion !== 1 || !isRecord(value.base) || !isRecord(value.candidate)
    || !hasKeys(value.base, ["gitCommit", "pins"]) || !hasKeys(value.candidate, ["gitCommit", "pins"])
    || !isRecord(value.base.pins) || !isRecord(value.candidate.pins))
    return { reasons: ["classifier report version or commit fields are invalid"] };
  if (!SHA.test(expected.base) || !SHA.test(expected.candidate) || value.base.gitCommit !== expected.base || value.candidate.gitCommit !== expected.candidate)
    return { reasons: ["classifier report does not cover current main and exact pull request head"] };
  if (typeof value.databaseChanged !== "boolean" || typeof value.workflowChanged !== "boolean" || !isRecord(value.evidence)
    || !hasKeys(value.evidence, ["database", "workflow"]))
    return { reasons: ["classifier flags or evidence are invalid"] };
  const database = validateEvidence(value.evidence.database);
  const workflow = validateEvidence(value.evidence.workflow);
  if (!database || !workflow) return { reasons: ["classifier impact evidence is invalid"] };
  if (value.databaseChanged !== (database.state !== "unchanged") || value.workflowChanged !== (workflow.state !== "unchanged"))
    return { reasons: ["classifier flags do not match the reported impact states"] };

  const decision: ClassificationDecision = {
    databaseChanged: value.databaseChanged,
    workflowChanged: value.workflowChanged,
    labels: [
      ...(value.databaseChanged ? [RELEASE_CLASSIFICATION_LABELS.database] : []),
      ...(value.workflowChanged ? [RELEASE_CLASSIFICATION_LABELS.workflow] : []),
      ...(value.databaseChanged || value.workflowChanged ? [RELEASE_CLASSIFICATION_LABELS.manual] : []),
    ],
  };
  return { decision, reasons: [] };
}

export function impactPaths(evidence: ClassificationEvidence): string[] {
  const paths = new Set<string>();
  for (const source of evidence.sources) {
    if (source.state === "unchanged") continue;
    for (const path of source.changedPaths) {
      const safe = safeSourcePath(path);
      if (safe) paths.add(safe);
    }
  }
  return [...paths].sort();
}

function validateEvidence(value: unknown): ClassificationEvidence | undefined {
  if (!isRecord(value) || !hasKeys(value, ["state", "sources"]) || !isImpactState(value.state) || !Array.isArray(value.sources)) return undefined;
  const sources: ClassificationEvidence["sources"] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || !hasKeys(source, ["name", "state", "base", "candidate", "changedPaths"], ["reason"])
      || typeof source.name !== "string" || !isImpactState(source.state) || typeof source.base !== "string"
      || typeof source.candidate !== "string" || !Array.isArray(source.changedPaths)
      || source.changedPaths.some((path) => typeof path !== "string")
      || source.reason !== undefined && typeof source.reason !== "string") return undefined;
    sources.push({
      name: source.name,
      state: source.state,
      base: source.base,
      candidate: source.candidate,
      changedPaths: source.changedPaths as string[],
      ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
    });
  }
  const state = sources.some((source) => source.state === "changed")
    ? "changed"
    : sources.some((source) => source.state === "unknown")
      ? "unknown"
      : "unchanged";
  if (value.state !== state) return undefined;
  return { state: value.state, sources };
}

function isImpactState(value: unknown): value is ImpactState {
  return value === "unchanged" || value === "changed" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeSourcePath(value: string): string | undefined {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return undefined;
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return /^[A-Za-z0-9._/-]{1,300}$/.test(value) ? value : undefined;
}
