export type Architecture = "amd64" | "arm64";

export type AssetPin = {
  name: string;
  sha256: string;
};

export type ArtifactPin = {
  repository: string;
  tag: string;
  commit: string;
  binary: string;
  assets: Record<Architecture, AssetPin>;
};

export type ReleasePins = {
  tools: { repository: string; commit: string };
  home: ArtifactPin;
  node: ArtifactPin;
};

export type PatchRecord = {
  file: string;
  upstream_pull_request: number | null;
  database_sensitive: boolean;
  workflow_sensitive: boolean;
};

export type PatchManifest = {
  format_version: 1;
  repository: string;
  patches: PatchRecord[];
};

export type ChangedFile = { filename: string; patch?: string };

export type SourceComparison = {
  complete: boolean;
  status?: "ahead" | "behind" | "identical" | "diverged";
  files: ChangedFile[];
};

export type Evidence = {
  state: "unchanged" | "changed" | "unknown";
  sources: Array<{
    name: string;
    state: "unchanged" | "changed" | "unknown";
    base: string;
    candidate: string;
    changedPaths: string[];
    reason?: string;
  }>;
};

export type ClassificationReport = {
  schemaVersion: 1;
  base: { gitCommit: string; pins: ReleasePins };
  candidate: { gitCommit: string; pins: ReleasePins };
  databaseChanged: boolean;
  workflowChanged: boolean;
  evidence: { database: Evidence; workflow: Evidence };
};
