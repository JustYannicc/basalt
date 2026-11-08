export interface ImportEntry {
  path: string;
  kind: "note" | "attachment";
  bytes: number;
  hash: string;
}
export interface ImportPlan {
  id: string;
  page: number;
  entries: readonly ImportEntry[];
  removed?: readonly string[];
  final: boolean;
}
export interface ImportStatus {
  id: string;
  state: "planning" | "ready" | "complete";
  nextPage: number;
  files: number;
  bytes: number;
  confirmed: number;
  omitted: number;
  manifest: string;
  reserved: { classA: number; classB: number; readBytes: number };
  used: { classA: number; classB: number; readBytes: number };
  reservedCostMicros: number;
  usedCostMicros: number;
  expiresAt: number;
}
export interface InitialRemote {
  current(): Promise<ImportStatus | null>;
  plan(input: ImportPlan): Promise<ImportStatus>;
  finish(id: string): Promise<ImportStatus>;
  activate(id: string | null): void;
}
export interface InitialState {
  phase: "planning" | "ready" | "complete";
  entries: ImportEntry[];
  done: Record<string, boolean>;
  nextPage: number;
  pending: ImportPlan | null;
}
