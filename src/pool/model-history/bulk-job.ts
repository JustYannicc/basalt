import type { BulkDefinition, BulkGuard, BulkIdentity, BulkStatus } from "./bulk-contract.ts";
import { maximumBulkChunkBytes, maximumBulkRows } from "./bulk-contract.ts";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
interface Counts {
  inserted: number;
  existing: number;
  count: number;
}
interface JobState {
  definition: BulkDefinition;
  state: "uploading" | "running" | "paused" | "completed";
  approved: boolean;
  uploaded: boolean[];
  receipts: (Counts | null)[];
  guard: BulkGuard | null;
  reason: string | null;
}
export interface BulkJobDependencies {
  storage: Storage;
  setAlarm(at: number): Promise<unknown>;
  artifacts: {
    put(job: string, index: number, data: string): Promise<unknown>;
    get(job: string, index: number): Promise<string | null>;
  };
  validateChunk(definition: BulkDefinition, index: number, data: string): Promise<void>;
  /** Commits rows and their replay receipt in one transaction, returning the original counts. */
  commitChunk(definition: BulkDefinition, index: number, data: string): Promise<Counts>;
  admit(definition: BulkDefinition): Promise<void>;
  now(): number;
  intervalMs?: 100 | 1000;
}
const key = "model-history-bulk-job-v1";
const sameIdentity = (a: BulkIdentity, b: BulkIdentity) =>
  a.pool === b.pool && a.organization === b.organization && a.owner === b.owner;
const freshGuard = (guard: BulkGuard | null, now: number): guard is BulkGuard =>
  guard !== null &&
  guard.ready === true &&
  [guard.observedAt, guard.expiresAt, guard.cpu, guard.poolErrors, guard.queryErrors].every(
    Number.isFinite,
  ) &&
  guard.cpu >= 0 &&
  guard.cpu <= 100 &&
  guard.poolErrors === 0 &&
  guard.queryErrors === 0 &&
  guard.observedAt <= now &&
  guard.expiresAt > now &&
  guard.expiresAt - guard.observedAt <= 90_000 &&
  now - guard.observedAt <= 90_000;

/** The root authenticates every command and constructs its identity from the authenticated owner. */
export class BulkJob {
  private tail: Promise<unknown> = Promise.resolve();
  private ticking: Promise<void> | null = null;
  private readonly dependencies: BulkJobDependencies;
  constructor(dependencies: BulkJobDependencies) {
    this.dependencies = dependencies;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async load(identity?: BulkIdentity) {
    const state = await this.dependencies.storage.get<JobState>(key);
    if (!state) throw new Error("Bulk job does not exist");
    if (identity && !sameIdentity(identity, state.definition.identity))
      throw new Error("Bulk job owner mismatch");
    return state;
  }
  private save(state: JobState) {
    return this.dependencies.storage.put(key, state);
  }
  private arm() {
    return this.dependencies.setAlarm(
      this.dependencies.now() + (this.dependencies.intervalMs ?? 1000),
    );
  }
  private summary(state: JobState): BulkStatus {
    return {
      job: state.definition.job,
      state: state.state,
      manifestDigest: state.definition.manifestDigest,
      accountMappingDigest: state.definition.accountMappingDigest,
      totalRows: state.definition.manifest.totalRows,
      totalChunks: state.uploaded.length,
      uploadedChunks: state.uploaded.filter(Boolean).length,
      committedChunks: state.receipts.filter(Boolean).length,
      inserted: state.receipts.reduce((sum, receipt) => sum + (receipt?.inserted ?? 0), 0),
      existing: state.receipts.reduce((sum, receipt) => sum + (receipt?.existing ?? 0), 0),
      reason: state.reason,
    };
  }
  async begin(definition: BulkDefinition): Promise<BulkStatus> {
    // Detach caller-owned objects before the first await, including their nested manifest and map.
    const immutable: BulkDefinition = structuredClone(definition);
    return this.serialized(async () => {
      const existing = await this.dependencies.storage.get<JobState>(key);
      if (existing) {
        if (JSON.stringify(existing.definition) !== JSON.stringify(immutable))
          throw new Error("Bulk job definition is immutable");
        return this.summary(existing);
      }
      const state: JobState = {
        definition: immutable,
        state: "uploading",
        approved: false,
        uploaded: immutable.manifest.chunks.map(() => false),
        receipts: immutable.manifest.chunks.map(() => null),
        guard: null,
        reason: null,
      };
      await this.save(state);
      return this.summary(state);
    });
  }
  async upload(identity: BulkIdentity, index: number, data: string): Promise<BulkStatus> {
    const initial = await this.serialized(() => this.load(identity));
    const chunk = initial.definition.manifest.chunks[index];
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !chunk ||
      chunk.rows < 1 ||
      chunk.rows > maximumBulkRows ||
      typeof data !== "string" ||
      new TextEncoder().encode(data).length > maximumBulkChunkBytes
    )
      throw new Error("Invalid bulk chunk");
    await this.dependencies.validateChunk(structuredClone(initial.definition), index, data);
    return this.serialized(async () => {
      const state = await this.load(identity);
      const previous = await this.dependencies.artifacts.get(state.definition.job, index);
      if (previous !== null && previous !== data) throw new Error("Bulk chunk is immutable");
      if (state.approved && !state.uploaded[index]) throw new Error("Bulk uploads are closed");
      if (previous === null)
        await this.dependencies.artifacts.put(state.definition.job, index, data);
      state.uploaded[index] = true;
      await this.save(state);
      return this.summary(state);
    });
  }
  approve(identity: BulkIdentity, manifestDigest: string, mapACK: string): Promise<BulkStatus> {
    return this.serialized(async () => {
      const state = await this.load(identity);
      if (
        manifestDigest !== state.definition.manifestDigest ||
        mapACK !== state.definition.accountMappingDigest ||
        state.uploaded.some((value) => !value)
      )
        throw new Error("Bulk approval does not match the uploaded manifest and account map");
      if (!state.approved) {
        state.approved = true;
        if (state.reason !== "operator_paused") {
          state.state = "running";
          state.reason = null;
        }
        await this.save(state);
      }
      if (state.state === "running") await this.arm();
      return this.summary(state);
    });
  }
  observe(identity: BulkIdentity, guard: BulkGuard): Promise<BulkStatus> {
    const observation = structuredClone(guard);
    return this.serialized(async () => {
      const state = await this.load(identity);
      const ready = freshGuard(observation, this.dependencies.now());
      state.guard = ready ? observation : null;
      if (state.approved && state.state !== "completed") {
        if (!ready && state.state === "running") {
          state.state = "paused";
          state.reason = "guard_paused";
        } else if (ready && state.state === "paused" && state.reason === "guard_paused") {
          state.state = "running";
          state.reason = null;
        }
      }
      await this.save(state);
      if (state.state === "running") await this.arm();
      return this.summary(state);
    });
  }
  pause(identity: BulkIdentity): Promise<BulkStatus> {
    return this.serialized(async () => {
      const state = await this.load(identity);
      if (state.state !== "completed") {
        state.state = "paused";
        state.reason = "operator_paused";
        await this.save(state);
      }
      return this.summary(state);
    });
  }
  resume(identity: BulkIdentity): Promise<BulkStatus> {
    return this.serialized(async () => {
      const state = await this.load(identity);
      if (!state.approved) throw new Error("Bulk job requires manifest approval");
      if (state.state !== "completed") {
        if (!freshGuard(state.guard, this.dependencies.now()))
          throw new Error("Bulk job requires a fresh ready guard");
        state.state = state.receipts.every(Boolean) ? "completed" : "running";
        state.reason = null;
        await this.save(state);
        if (state.state === "running") await this.arm();
      }
      return this.summary(state);
    });
  }
  status(identity: BulkIdentity): Promise<BulkStatus> {
    return this.serialized(async () => this.summary(await this.load(identity)));
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  private async ready() {
    return this.serialized(async () => {
      const state = await this.load();
      if (state.state !== "running" || !state.approved) return null;
      if (!freshGuard(state.guard, this.dependencies.now())) {
        state.state = "paused";
        state.reason = "guard_paused";
        await this.save(state);
        return null;
      }
      return state;
    });
  }
  private async runTick() {
    const initial = await this.ready();
    if (!initial) return;
    // Persist the recovery wake before external I/O. Reboots replay only the atomic SQL receipt.
    await this.arm();
    const index = initial.receipts.findIndex((receipt) => receipt === null);
    if (index < 0) return;
    const definition = initial.definition;
    let reason = "chunk_unavailable";
    try {
      const data = await this.dependencies.artifacts.get(definition.job, index);
      if (data === null) throw new Error("Missing bulk chunk");
      reason = "chunk_invalid";
      const chunk = definition.manifest.chunks[index]!;
      if (
        chunk.rows < 1 ||
        chunk.rows > maximumBulkRows ||
        new TextEncoder().encode(data).length > maximumBulkChunkBytes
      )
        throw new Error("Invalid bulk chunk");
      await this.dependencies.validateChunk(structuredClone(definition), index, data);
      reason = "admission_failed";
      await this.dependencies.admit(structuredClone(definition));
      if (!(await this.ready())) return;
      reason = "commit_failed";
      const receipt = await this.dependencies.commitChunk(structuredClone(definition), index, data);
      if (
        ![receipt.inserted, receipt.existing, receipt.count].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        receipt.count !== chunk.rows ||
        receipt.inserted + receipt.existing !== receipt.count
      )
        throw new Error("Invalid bulk receipt");
      await this.serialized(async () => {
        const state = await this.load();
        state.receipts[index] = { ...receipt };
        if (state.state === "running" && state.receipts.every(Boolean)) state.state = "completed";
        await this.save(state);
        if (state.state === "running") await this.arm();
      });
    } catch {
      await this.serialized(async () => {
        const state = await this.load();
        if (state.state === "running") {
          state.state = "paused";
          state.reason = reason;
          await this.save(state);
        }
      });
    }
  }
}
