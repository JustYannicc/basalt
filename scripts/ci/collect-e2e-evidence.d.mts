export type EvidenceSummary = { files: number; bytes: number };
export function collectE2eEvidence(
  source: string,
  destination: string,
  ...fallbacks: string[]
): Promise<EvidenceSummary>;
export function runNames(roots: readonly string[]): Promise<Set<string>[]>;
export function collectNewE2eEvidence(
  roots: readonly string[],
  before: readonly Set<string>[],
  destination: string,
): Promise<EvidenceSummary>;
