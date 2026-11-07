import type { Result } from "../control.ts";
import type { UsageImportPage, UsageImportResult } from "../import-contract.ts";
import { importPageDigest, type ImportPage, type ImportSource } from "./import-source.ts";

export type ImportPhase =
  | "choose"
  | "previewing"
  | "review"
  | "importing"
  | "paused"
  | "complete"
  | "error";
export interface ImportProgress {
  phase: ImportPhase;
  label: string;
  checked: number;
  total: number;
  added: number;
  existing: number;
  from: string | null;
  to: string | null;
  aggregateOnly: string;
  indistinguishable: number;
  error: string | null;
}
export type ImportSend = (page: UsageImportPage) => Promise<Result<UsageImportResult>>;
const initial = (): ImportProgress => ({
  phase: "choose",
  label: "",
  checked: 0,
  total: 0,
  added: 0,
  existing: 0,
  from: null,
  to: null,
  aggregateOnly: "0",
  indistinguishable: 0,
  error: null,
});

/** One tab owns the selected file and reviewed page hashes. Navigation does not own the job. */
export class ImportSession {
  snapshot = initial();
  private listeners = new Set<() => void>();
  private source?: ImportSource;
  private hashes: string[] = [];
  private running = false;
  private paused = false;
  private appliedPages = 0;
  private readonly send: ImportSend;
  private readonly checkpoint: ((progress: ImportProgress) => void) | undefined;

  constructor(send: ImportSend, checkpoint?: (progress: ImportProgress) => void) {
    this.send = send;
    this.checkpoint = checkpoint;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<ImportProgress>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.checkpoint?.(this.snapshot);
    for (const listener of this.listeners) listener();
  }
  private async request(page: ImportPage, mode: UsageImportPage["mode"], approval?: string) {
    const response = await this.send({
      ...page,
      source: this.source?.database ?? this.source?.label ?? "",
      mode,
      ...(approval === undefined ? {} : { approval }),
    });
    if (!response.ok) throw new Error(response.message);
    const report = response.value;
    if (
      report.mode !== mode ||
      !Number.isSafeInteger(report.pageDetails) ||
      report.pageDetails < 0 ||
      report.pageDetails > 200 ||
      (mode === "dry-run" && !report.approval)
    )
      throw new Error("The pool returned an invalid import report. Nothing else was sent.");
    return report;
  }

  async preview(source: ImportSource) {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.source = source;
    this.hashes = [];
    this.appliedPages = 0;
    this.update({ ...initial(), phase: "previewing", label: source.label });
    const pages = source.pages();
    try {
      let step = await pages.next();
      while (!step.done) {
        if (this.paused) {
          this.source = undefined;
          this.update({ phase: "choose" });
          return;
        }
        const page = step.value,
          report = await this.request(page, "dry-run");
        this.hashes.push(await importPageDigest(page));
        const at = [this.snapshot.from, report.from].filter((v): v is string => v !== null).sort();
        const to = [this.snapshot.to, report.to].filter((v): v is string => v !== null).sort();
        this.update({
          checked: this.snapshot.checked + report.pageDetails,
          total: this.snapshot.total + report.pageDetails,
          existing: this.snapshot.existing + report.existing,
          from: at[0] ?? null,
          to: to.at(-1) ?? null,
          aggregateOnly: report.aggregateOnlyNotImportable,
          indistinguishable: report.indistinguishableDetails,
        });
        step = await pages.next(report);
      }
      if (this.paused) {
        this.source = undefined;
        this.update({ phase: "choose" });
        return;
      }
      if (!this.hashes.length) throw new Error("This export has no retained metadata records.");
      this.update({ phase: "review" });
    } catch (error) {
      this.source = undefined;
      this.update({
        phase: "error",
        error: error instanceof Error ? error.message : "Couldn't read this usage export.",
      });
    } finally {
      await pages.return();
      this.running = false;
    }
  }

  pause() {
    this.paused = true;
  }

  /** Called only by the person's Import or Resume button, after a complete preview. */
  async apply() {
    if (
      this.running ||
      !this.source ||
      !["review", "paused", "error"].includes(this.snapshot.phase)
    )
      return;
    this.running = true;
    this.paused = false;
    if (this.snapshot.phase === "review") this.update({ checked: 0, existing: 0 });
    this.update({ phase: "importing", error: null });
    const pages = this.source.pages();
    try {
      let index = 0,
        step = await pages.next();
      while (!step.done) {
        if (this.paused) {
          this.update({ phase: "paused" });
          return;
        }
        const page = step.value;
        if ((await importPageDigest(page)) !== this.hashes[index])
          throw new Error(
            "The export changed after its preview. Choose it again before importing.",
          );
        // Re-preview immediately before apply: approvals expire, and other imports may have added rows.
        const report = await this.request(page, "dry-run");
        if (index >= this.appliedPages) {
          if (this.paused) {
            this.update({ phase: "paused" });
            return;
          }
          const saved = await this.request(page, "apply", report.approval!);
          this.appliedPages = index + 1;
          this.update({
            checked: this.snapshot.checked + saved.pageDetails,
            added: this.snapshot.added + saved.inserted,
            existing: this.snapshot.existing + saved.pageDetails - saved.inserted,
          });
        }
        index++;
        step = await pages.next(report);
      }
      if (index !== this.hashes.length)
        throw new Error("The export changed after its preview. Choose it again before importing.");
      this.update({ phase: "complete" });
    } catch (error) {
      this.update({
        phase: "error",
        error: error instanceof Error ? error.message : "The import was interrupted.",
      });
    } finally {
      await pages.return();
      this.running = false;
    }
  }

  canResume() {
    return this.source !== undefined && this.hashes.length > 0;
  }
  reset() {
    if (this.running) return;
    this.source = undefined;
    this.hashes = [];
    this.appliedPages = 0;
    this.update(initial());
  }
}
