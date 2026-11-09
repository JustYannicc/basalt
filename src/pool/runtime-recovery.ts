import { Schema } from "effect";
import type { PoolStatus } from "./lifecycle.ts";
import { openEnvelope } from "./token.ts";

export const runtimeRecoveryPath = "/runtime-recovery";
export const runtimeRecoveryPrefix = "sbpr1";
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recoveryFields = {
  version: Schema.Literal(1),
  operationId: Schema.String,
  instanceId: Schema.String,
  imageHash: Schema.String,
  at: Schema.Number,
  expiresAt: Schema.Number,
};
const SignedRecovery = Schema.Union([
  Schema.Struct({ ...recoveryFields, action: Schema.Literal("restart") }),
  Schema.Struct({
    ...recoveryFields,
    action: Schema.Literal("restart-reviewed"),
    release: Schema.String,
    bootId: Schema.String,
  }),
]);
export type RecoveryApproval = typeof SignedRecovery.Type;
export interface RecoveryReceipt {
  operationId: string;
  instanceId: string;
  imageHash: string;
  status: "started" | "ready" | "failed";
  startedAt: number;
  finishedAt?: number;
  bootId?: string;
  release?: string;
  previousBootId?: string;
  failure?: "restart-failed" | "boot-unchanged";
}
interface RecoveryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: RecoveryReceipt): Promise<void>;
}
interface RecoveryRuntime {
  instanceId: string;
  imageHash: string;
  release?: string;
  running(): boolean;
  status(): Promise<PoolStatus>;
  restart(beforeStop?: () => Promise<void>): Promise<PoolStatus>;
}
export interface RecoveryDrift {
  property: "release" | "instanceId" | "imageHash" | "bootId";
  expected: string;
  observed: string;
}
export class RecoveryRefused extends Error {
  readonly status: number;
  readonly drift?: RecoveryDrift[];
  constructor(status: number, drift?: RecoveryDrift[]) {
    super("Pool runtime recovery refused");
    this.status = status;
    this.drift = drift;
  }
}

/** A durable started receipt consumes the approval even if the object loses the restart result. */
export class RuntimeRecovery {
  private pending: Promise<unknown> = Promise.resolve();
  private runtime: RecoveryRuntime;
  private storage: RecoveryStorage;
  private now: () => number;
  constructor(runtime: RecoveryRuntime, storage: RecoveryStorage, now = Date.now) {
    this.runtime = runtime;
    this.storage = storage;
    this.now = now;
  }

  async inspect(id?: string) {
    if (id !== undefined && !operationId.test(id)) throw new RecoveryRefused(400);
    const running = this.runtime.running();
    const health = running ? await this.runtime.status().catch(() => undefined) : undefined;
    const receipt =
      id === undefined ? undefined : await this.storage.get<RecoveryReceipt>(this.key(id));
    return {
      instanceId: this.runtime.instanceId,
      imageHash: this.runtime.imageHash,
      running,
      ...(this.runtime.release ? { release: this.runtime.release } : {}),
      ready: health !== undefined,
      ...(health ? { bootId: health.boot_id } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  run(approval: RecoveryApproval): Promise<RecoveryReceipt> {
    const result = this.pending.then(async () => {
      if (
        approval.instanceId !== this.runtime.instanceId ||
        approval.imageHash !== this.runtime.imageHash
      ) {
        const drift = (["instanceId", "imageHash"] as const)
          .filter((property) => approval[property] !== this.runtime[property])
          .map((property) => ({
            property,
            expected: approval[property],
            observed: /^[a-f0-9]{16,64}$/.test(this.runtime[property])
              ? this.runtime[property]
              : "unavailable",
          }));
        throw new RecoveryRefused(409, approval.action === "restart-reviewed" ? drift : undefined);
      }
      const key = this.key(approval.operationId);
      const previous = await this.storage.get<RecoveryReceipt>(key);
      if (previous) {
        if (
          approval.action === "restart-reviewed" &&
          (previous.release !== approval.release || previous.previousBootId !== approval.bootId)
        )
          throw new RecoveryRefused(409);
        return previous;
      }
      if (approval.expiresAt <= this.now()) throw new RecoveryRefused(401);
      const started: RecoveryReceipt = {
        operationId: approval.operationId,
        instanceId: approval.instanceId,
        imageHash: approval.imageHash,
        status: "started",
        startedAt: this.now(),
        ...(approval.action === "restart-reviewed"
          ? { release: approval.release, previousBootId: approval.bootId }
          : {}),
      };
      let consumed = false;
      const begin = async () => {
        if (approval.expiresAt <= this.now()) throw new RecoveryRefused(401);
        if (approval.action === "restart-reviewed") {
          const health = await this.runtime.status().catch(() => undefined);
          const observed = {
            release: /^[a-f0-9]{40}$/.test(this.runtime.release ?? "")
              ? this.runtime.release!
              : "unavailable",
            bootId: operationId.test(health?.boot_id ?? "") ? health!.boot_id : "unavailable",
            instanceId: /^[a-f0-9]{64}$/.test(this.runtime.instanceId)
              ? this.runtime.instanceId
              : "unavailable",
            imageHash: /^[a-f0-9]{16,64}$/.test(this.runtime.imageHash)
              ? this.runtime.imageHash
              : "unavailable",
          };
          const drift = (["release", "instanceId", "imageHash", "bootId"] as const)
            .filter((property) => approval[property] !== observed[property])
            .map((property) => ({
              property,
              expected: approval[property],
              observed: observed[property],
            }));
          if (drift.length) throw new RecoveryRefused(409, drift);
        }
        if (approval.expiresAt <= this.now()) throw new RecoveryRefused(401);
        await this.storage.put(key, started);
        consumed = true;
      };
      if (approval.action === "restart") await begin();
      let receipt: RecoveryReceipt;
      try {
        // The lifecycle runs this guard after any pending warm, directly before its stop.
        const status = await this.runtime.restart(
          approval.action === "restart-reviewed" ? begin : undefined,
        );
        if (!consumed) throw new RecoveryRefused(503);
        const unchanged =
          approval.action === "restart-reviewed" && status.boot_id === approval.bootId;
        receipt = {
          ...started,
          status: unchanged ? "failed" : "ready",
          finishedAt: this.now(),
          bootId: status.boot_id,
          ...(unchanged ? { failure: "boot-unchanged" as const } : {}),
        };
      } catch (error) {
        if (!consumed) throw error;
        receipt = {
          ...started,
          status: "failed",
          finishedAt: this.now(),
          failure: "restart-failed",
        };
      }
      await this.storage.put(key, receipt);
      return receipt;
    });
    this.pending = result.catch(() => {});
    return result;
  }

  private key(id: string) {
    return `runtime-recovery-v1:${id}`;
  }
}

interface RecoveryService {
  inspectRuntimeRecovery(id?: string): Promise<Awaited<ReturnType<RuntimeRecovery["inspect"]>>>;
  recoverRuntime(approval: RecoveryApproval): Promise<RecoveryReceipt>;
}

/** Called only by the named private service entrypoint. The signer binds the exact restart target. */
export async function handleRuntimeRecovery(
  request: Request,
  service: RecoveryService,
  secret: string,
) {
  try {
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("operationId") ?? undefined;
      return Response.json(await service.inspectRuntimeRecovery(id), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method !== "POST") throw new RecoveryRefused(405);
    const text = await request.text();
    if (text.length > 8_192) throw new RecoveryRefused(413);
    const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
      JSON.parse(text),
    );
    const decoded = await openEnvelope(secret, runtimeRecoveryPrefix, body.envelope);
    if (decoded === undefined) throw new RecoveryRefused(401);
    const approval = Schema.decodeUnknownSync(SignedRecovery)(decoded);
    const now = Date.now();
    if (
      !operationId.test(approval.operationId) ||
      !/^[a-f0-9]{64}$/.test(approval.instanceId) ||
      !approval.imageHash ||
      approval.imageHash.length > 256 ||
      !Number.isSafeInteger(approval.at) ||
      !Number.isSafeInteger(approval.expiresAt) ||
      approval.at > now + 5_000 ||
      approval.expiresAt <= now ||
      approval.expiresAt <= approval.at ||
      approval.expiresAt > approval.at + 60_000
    )
      throw new RecoveryRefused(401);
    if (
      approval.action === "restart-reviewed" &&
      (!/^[a-f0-9]{40}$/.test(approval.release) ||
        !operationId.test(approval.bootId) ||
        !/^[a-f0-9]{16,64}$/.test(approval.imageHash))
    )
      throw new RecoveryRefused(401);
    const receipt = await service.recoverRuntime(approval);
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: "runtime_recovery_refused",
        ...(error instanceof RecoveryRefused && error.drift ? { drift: error.drift } : {}),
      },
      {
        status: error instanceof RecoveryRefused ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
