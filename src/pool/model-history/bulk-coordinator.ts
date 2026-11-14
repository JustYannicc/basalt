import { BulkJob } from "./bulk-job.ts";
import { bulkCommand } from "./bulk-http.ts";
import { bulkHash, bulkInteger, type BulkDefinition, type BulkGuard } from "./bulk-contract.ts";
import { parseBulkChunk } from "./bulk-parser.ts";
import { commitBulkChunk, validateBulkTargets } from "./bulk-progress.ts";
import { type UsageStorage, ChunkStorage } from "../usage-storage.ts";
import { fail, json } from "../json.ts";
import { signEnvelope } from "../token.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { importFailure } from "./import-page.ts";
import { servingObservation } from "./bulk-serving-contract.ts";

export interface BulkEnvironment {
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_AUTH_DATABASE?: { connectionString: string };
  UsageImportArtifacts: {
    put(key: string, data: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
  TOOLS_SERVICE: { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export const bulkObjectName = (job: string) => `bulk-usage-import:${bulkHash(job)}`;
const modeKey = "bulk-usage-import-object-v1";
const objectKey = (job: string, index: number) =>
  `usage-import-v1/${bulkHash(job)}/${bulkInteger(index, 0, 9999)}.ndjson`;
export interface BulkState {
  storage: UsageStorage & { setAlarm(at: number): Promise<unknown> };
}
export const bulkObjectJob = (state: BulkState) =>
  new ChunkStorage(state.storage).get<string>(modeKey);

class BulkImportObject {
  private job: BulkJob;
  constructor(
    ctx: BulkState,
    private env: BulkEnvironment,
    private expectedJob: string,
    private now: () => number,
  ) {
    const chunks = new ChunkStorage(ctx.storage);
    this.job = new BulkJob({
      storage: {
        get: (key) => chunks.get(key),
        put: (key, value) =>
          chunks.commit(
            new Map([
              [key, value],
              [modeKey, expectedJob],
            ]),
            [],
            "bulk-state-publication",
          ),
      },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      artifacts: {
        put: (job, index, data) => env.UsageImportArtifacts.put(objectKey(job, index), data),
        get: async (job, index) =>
          (await env.UsageImportArtifacts.get(objectKey(job, index)))?.text() ?? null,
      },
      validateChunk: async (definition, index, data) => {
        await parseBulkChunk(definition, index, data);
      },
      commitChunk: (definition, index, data, start, rows) =>
        commitBulkChunk(
          env.POOL_AUTH_DATABASE?.connectionString,
          definition,
          index,
          data,
          start,
          rows,
        ),
      admit: (definition) => this.admit(definition),
      now: () => this.now(),
    });
  }
  private async admit(definition: BulkDefinition) {
    const at = Date.now();
    const envelope = await signEnvelope(this.env.POOL_APP_SIGNING_KEY, "sbq1", {
      action: "usageImportAdmission",
      ...definition.identity,
      job: definition.job,
      at,
      expiresAt: at + 30_000,
    });
    const response = await this.env.TOOLS_SERVICE.fetch(
      "https://api.internal/api/internal/pool-usage-import-admission",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    await response.body?.cancel();
    if (response.status !== 204) throw new Error("Bulk import owner admission failed");
  }
  async execute(command: NonNullable<Awaited<ReturnType<typeof bulkCommand>>>) {
    try {
      if (command.job !== this.expectedJob)
        return fail(401, "unauthorized", "The import assertion does not match this job.");
      const { input, identity, definition } = command;
      let result;
      switch (input.operation) {
        case "begin":
          if (!definition) throw new HistoryInputError();
          await this.admit(definition);
          await validateBulkTargets(this.env.POOL_AUTH_DATABASE?.connectionString, definition);
          result = await this.job.begin(definition);
          break;
        case "upload":
          if (typeof input.data !== "string") throw new HistoryInputError();
          result = await this.job.upload(identity, bulkInteger(input.chunk, 0, 9999), input.data);
          break;
        case "approve":
          result = await this.job.approve(
            identity,
            bulkHash(input.manifestDigest),
            bulkHash(input.accountMappingDigest),
          );
          break;
        case "guard": {
          const raw = historyObject(input.observation);
          if (
            typeof raw.ready !== "boolean" ||
            typeof raw.cpu !== "number" ||
            typeof raw.releaseReadComplete !== "boolean" ||
            typeof raw.releaseWindowActive !== "boolean"
          )
            throw new HistoryInputError();
          const observation: BulkGuard = {
            observedAt: bulkInteger(raw.observedAt, 0, Number.MAX_SAFE_INTEGER),
            expiresAt: bulkInteger(raw.expiresAt, 0, Number.MAX_SAFE_INTEGER),
            ready: raw.ready,
            cpu: raw.cpu,
            cpuAt: bulkInteger(raw.cpuAt, 0, Number.MAX_SAFE_INTEGER),
            releaseReadComplete: raw.releaseReadComplete,
            releaseWindowActive: raw.releaseWindowActive,
            serving: servingObservation(raw.serving),
            poolErrors: bulkInteger(raw.poolErrors, 0, Number.MAX_SAFE_INTEGER),
            queryErrors: bulkInteger(raw.queryErrors, 0, Number.MAX_SAFE_INTEGER),
          };
          result = await this.job.observe(identity, observation);
          break;
        }
        case "pause":
          result = await this.job.pause(identity);
          break;
        case "resume":
          result = await this.job.resume(identity);
          break;
        case "status":
          result = await this.job.status(identity);
          break;
        default:
          throw new HistoryInputError();
      }
      return json(result);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Bulk "))
        return json(
          {
            error: "invalid_query",
            message: "Bulk usage import was refused. Check the saved job state.",
          },
          409,
        );
      return importFailure(error);
    }
  }
  async alarm() {
    await this.job.tick();
  }
}

/** The shared class supplies only this object's storage and a native id comparison. */
export class BulkCoordinator {
  private opened?: { job: string; object: BulkImportObject };
  constructor(
    private state: BulkState,
    private env: BulkEnvironment,
    private matches: (job: string) => boolean,
    private now: () => number = Date.now,
  ) {}
  private object(job: string) {
    bulkHash(job);
    if (!this.matches(job) || (this.opened && this.opened.job !== job)) return undefined;
    this.opened ??= {
      job,
      object: new BulkImportObject(this.state, this.env, job, this.now),
    };
    return this.opened.object;
  }
  async handle(request: Request) {
    try {
      const command = await bulkCommand(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
      });
      const object = command ? this.object(command.job) : undefined;
      if (!command || !object)
        return fail(401, "unauthorized", "A matching pool owner import assertion is required.");
      return await object.execute(command);
    } catch (error) {
      return importFailure(error);
    }
  }
  async alarm() {
    const job = await bulkObjectJob(this.state);
    if (job === undefined) return;
    const object = this.object(job);
    if (!object) throw new Error("Bulk alarm object identity mismatch");
    await object.alarm();
  }
}
