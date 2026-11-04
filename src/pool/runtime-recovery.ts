import { Schema } from "effect";
import type { PoolStatus } from "./lifecycle.ts";
import { openEnvelope } from "./token.ts";

export const runtimeRecoveryPath = "/runtime-recovery";
export const runtimeRecoveryPrefix = "sbpr1";
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SignedRecovery = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literal("restart"),
  operationId: Schema.String,
  instanceId: Schema.String,
  imageHash: Schema.String,
  at: Schema.Number,
  expiresAt: Schema.Number,
});
export type RecoveryApproval = typeof SignedRecovery.Type;
export interface RecoveryReceipt {
  operationId: string;
  instanceId: string;
  imageHash: string;
  status: "started" | "ready" | "failed";
  startedAt: number;
  finishedAt?: number;
  bootId?: string;
}
interface RecoveryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: RecoveryReceipt): Promise<void>;
}
interface RecoveryRuntime {
  instanceId: string;
  imageHash: string;
  running(): boolean;
  status(): Promise<PoolStatus>;
  restart(): Promise<PoolStatus>;
}
export class RecoveryRefused extends Error {
  readonly status: number;
  constructor(status: number) { super("Pool runtime recovery refused"); this.status = status; }
}

/** A durable started receipt consumes the approval even if the object loses the restart result. */
export class RuntimeRecovery {
  private pending: Promise<unknown> = Promise.resolve();
  private runtime: RecoveryRuntime;
  private storage: RecoveryStorage;
  private now: () => number;
  constructor(runtime: RecoveryRuntime, storage: RecoveryStorage, now = Date.now) {
    this.runtime = runtime; this.storage = storage; this.now = now;
  }

  async inspect(id?: string) {
    if (id !== undefined && !operationId.test(id)) throw new RecoveryRefused(400);
    const running = this.runtime.running();
    const health = running ? await this.runtime.status().catch(() => undefined) : undefined;
    const receipt = id === undefined ? undefined : await this.storage.get<RecoveryReceipt>(this.key(id));
    return { instanceId: this.runtime.instanceId, imageHash: this.runtime.imageHash, running,
      ready: health !== undefined, ...(health ? { bootId: health.boot_id } : {}),
      ...(receipt ? { receipt } : {}) };
  }

  run(approval: RecoveryApproval): Promise<RecoveryReceipt> {
    const result = this.pending.then(async () => {
      if (approval.instanceId !== this.runtime.instanceId || approval.imageHash !== this.runtime.imageHash)
        throw new RecoveryRefused(409);
      const key = this.key(approval.operationId);
      const previous = await this.storage.get<RecoveryReceipt>(key);
      if (previous) return previous;
      if (approval.expiresAt <= this.now()) throw new RecoveryRefused(401);
      const started: RecoveryReceipt = { operationId: approval.operationId, instanceId: approval.instanceId,
        imageHash: approval.imageHash, status: "started", startedAt: this.now() };
      await this.storage.put(key, started);
      let receipt: RecoveryReceipt;
      try {
        const status = await this.runtime.restart();
        receipt = { ...started, status: "ready", finishedAt: this.now(), bootId: status.boot_id };
      } catch {
        receipt = { ...started, status: "failed", finishedAt: this.now() };
      }
      await this.storage.put(key, receipt);
      return receipt;
    });
    this.pending = result.catch(() => {});
    return result;
  }

  private key(id: string) { return `runtime-recovery-v1:${id}`; }
}

interface RecoveryService {
  inspectRuntimeRecovery(id?: string): Promise<Awaited<ReturnType<RuntimeRecovery["inspect"]>>>;
  recoverRuntime(approval: RecoveryApproval): Promise<RecoveryReceipt>;
}

/** Called only by the named private service entrypoint. The signer binds the exact restart target. */
export async function handleRuntimeRecovery(request: Request, service: RecoveryService, secret: string) {
  try {
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("operationId") ?? undefined;
      return Response.json(await service.inspectRuntimeRecovery(id), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method !== "POST") throw new RecoveryRefused(405);
    const text = await request.text();
    if (text.length > 8_192) throw new RecoveryRefused(413);
    const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(JSON.parse(text));
    const decoded = await openEnvelope(secret, runtimeRecoveryPrefix, body.envelope);
    if (decoded === undefined) throw new RecoveryRefused(401);
    const approval = Schema.decodeUnknownSync(SignedRecovery)(decoded);
    const now = Date.now();
    if (!operationId.test(approval.operationId) || !/^[a-f0-9]{64}$/.test(approval.instanceId)
      || !approval.imageHash || approval.imageHash.length > 256
      || !Number.isSafeInteger(approval.at) || !Number.isSafeInteger(approval.expiresAt)
      || approval.at > now + 5_000 || approval.expiresAt <= now
      || approval.expiresAt <= approval.at || approval.expiresAt > approval.at + 60_000)
      throw new RecoveryRefused(401);
    const receipt = await service.recoverRuntime(approval);
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "runtime_recovery_refused" }, {
      status: error instanceof RecoveryRefused ? error.status : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
