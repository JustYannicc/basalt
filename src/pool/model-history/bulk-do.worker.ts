import { DurableObject } from "cloudflare:workers";
import { BulkJob } from "./bulk-job.ts";
import { bulkCommand } from "./bulk-http.ts";
import { bulkHash, bulkInteger, type BulkDefinition, type BulkGuard } from "./bulk-contract.ts";
import { parseBulkChunk } from "./bulk-parser.ts";
import { commitBulkChunk, validateBulkTargets } from "./bulk-progress.ts";
import { ChunkStorage } from "../usage-storage.ts";
import { fail, json } from "../json.ts";
import { signEnvelope } from "../token.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { importFailure } from "./import-page.ts";

export interface BulkEnvironment {
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_AUTH_DATABASE?: Hyperdrive;
  UsageImportArtifacts: R2Bucket;
  TOOLS_SERVICE: Fetcher;
}
const objectKey = (job: string, index: number) => `usage-import-v1/${job}/${index}.ndjson`;

export class BulkUsageImport extends DurableObject<BulkEnvironment> {
  private job: BulkJob;
  constructor(ctx: DurableObjectState, env: BulkEnvironment) {
    super(ctx, env);
    const chunks = new ChunkStorage(ctx.storage);
    this.job = new BulkJob({
      storage: {
        get: (key) => chunks.get(key),
        put: (key, value) => chunks.commit(new Map([[key, value]]), [], "bulk-state-publication"),
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
      commitChunk: (definition, index, data) =>
        commitBulkChunk(env.POOL_AUTH_DATABASE?.connectionString, definition, index, data),
      admit: (definition) => this.admit(definition),
      now: Date.now,
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
  async fetch(request: Request) {
    try {
      const command = await bulkCommand(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
      });
      if (!command)
        return fail(401, "unauthorized", "A current pool owner import assertion is required.");
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
          if (typeof raw.ready !== "boolean" || typeof raw.cpu !== "number")
            throw new HistoryInputError();
          const observation: BulkGuard = {
            observedAt: bulkInteger(raw.observedAt, 0, Number.MAX_SAFE_INTEGER),
            expiresAt: bulkInteger(raw.expiresAt, 0, Number.MAX_SAFE_INTEGER),
            ready: raw.ready,
            cpu: raw.cpu,
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
