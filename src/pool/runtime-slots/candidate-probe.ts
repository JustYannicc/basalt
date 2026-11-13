import { Schema } from "effect";
import { brand } from "../../../brand.ts";
import { PoolDirectory } from "../directory.ts";
import type { ComputerHome } from "../computer-home.ts";
import { appModelLabel } from "../app-model-contract.ts";
import { openEnvelope, signEnvelope } from "../token.ts";
import { deploymentReadinessPrefix } from "../deployment-readiness.ts";
import type { RefusalIdentity } from "../gateway-failure.ts";
import {
  ControllerCode,
  PromotionIntent,
  SlotIdentity,
  SlotRefused,
  sameIdentity,
} from "./contract.ts";
import { RuntimeSlotStorage, type SlotStorage, type TransactionStorage } from "./storage.ts";

export const candidateProbeHeader = "X-Signalbox-Candidate-Probe";
const Ticket = Schema.Struct({
  kind: Schema.Literal("candidate-serving"),
  operationId: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  controllerCode: ControllerCode,
  candidate: SlotIdentity,
  previous: SlotIdentity,
  expectedEpoch: Schema.Number,
  policyDigest: Schema.String,
  pool: Schema.NonEmptyString,
  expiresAt: Schema.Number,
});
type Ticket = typeof Ticket.Type;
const Record = Schema.Struct({
  ticket: Ticket,
  label: Schema.NonEmptyString,
  status: Schema.Literals(["started", "accepted", "failed"]),
  cleanup: Schema.Boolean,
  keyId: Schema.optional(Schema.Number),
  acceptedAt: Schema.optional(Schema.Number),
});
type Record = typeof Record.Type;
const pendingKey = "runtime-candidate-probe-v1:pending";
const receiptKey = (operationId: string) => `runtime-candidate-probe-v1:receipt:${operationId}`;
const servingKey = (value: Pick<Ticket, "candidate" | "expectedEpoch" | "policyDigest">) =>
  `runtime-candidate-probe-v1:serving:${JSON.stringify([value.candidate, value.expectedEpoch, value.policyDigest])}`;
interface Dependencies {
  storage: TransactionStorage;
  slots: RuntimeSlotStorage;
  code: ControllerCode;
  secret: string;
  home: Pick<ComputerHome, "mintAppModel" | "findAppModel" | "revoke">;
  schedule(at: number): Promise<unknown>;
  forward(
    request: Request,
    identity: SlotIdentity,
    pool: string,
    beforeDispatch: () => void,
  ): Promise<Response>;
  fetch?(request: Request): Promise<Response>;
  now?: () => number;
}

/** Only a successful authenticated public read can create the promotion's serving receipt. */
export class RuntimeCandidateProbe {
  private now: () => number;
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }
  async inspect(operationId: string, storage: SlotStorage = this.deps.storage) {
    const raw = await storage.get(receiptKey(operationId));
    return raw === undefined ? undefined : Schema.decodeUnknownSync(Record)(raw);
  }
  private async put(record: Record, storage: SlotStorage = this.deps.storage) {
    await storage.put(receiptKey(record.ticket.operationId), record);
    return record;
  }
  private async current(ticket: Ticket) {
    const snapshot = await this.deps.slots.inspect();
    if (
      ticket.expiresAt <= this.now() ||
      snapshot.selection?.epoch !== ticket.expectedEpoch ||
      snapshot.digest !== ticket.policyDigest ||
      snapshot.selection.candidate?.fenced ||
      snapshot.selection.candidate?.retirement ||
      !sameIdentity(snapshot.selection.active.identity, ticket.previous) ||
      !sameIdentity(snapshot.selection.candidate?.identity, ticket.candidate)
    )
      throw new SlotRefused("selection");
  }
  async probe(operationId: string, pool: string) {
    const before = await this.inspect(operationId);
    if (before) {
      if (before.ticket.pool !== pool || before.status !== "accepted")
        throw new SlotRefused("uncertain");
      return before;
    }
    const directory = await PoolDirectory.load(this.deps.storage, this.now());
    const entry = directory.entry(pool);
    if (
      !entry ||
      !entry.owner ||
      !directory.allowed(pool, entry.owner, this.now()) ||
      (entry.authorization === "executor-app-v1" &&
        !directory.permissions(pool, entry.owner)?.canUse)
    )
      throw new SlotRefused("policy");
    const record = await this.deps.slots.transact(async (snapshot, transaction) => {
      const selection = snapshot.selection;
      if (
        !selection?.candidate?.identity ||
        selection.candidate.fenced ||
        selection.candidate.retirement ||
        !selection.active.identity ||
        selection.active.fenced ||
        selection.draining ||
        (await transaction.get(pendingKey))
      )
        throw new SlotRefused("selection");
      if (await transaction.get(receiptKey(operationId))) throw new SlotRefused("uncertain");
      const nonce = crypto.randomUUID();
      const ticket: Ticket = {
        kind: "candidate-serving",
        operationId,
        nonce,
        controllerCode: this.deps.code,
        candidate: selection.candidate.identity,
        previous: selection.active.identity,
        expectedEpoch: selection.epoch,
        policyDigest: snapshot.digest,
        pool,
        expiresAt: this.now() + 60_000,
      };
      const record: Record = {
        ticket,
        label: appModelLabel("app_basalt_release", "serving", nonce),
        status: "started",
        cleanup: false,
      };
      await transaction.put(pendingKey, operationId);
      return this.put(record, transaction);
    });
    await this.deps.schedule(record.ticket.expiresAt);
    try {
      const signal = AbortSignal.timeout(20_000);
      const key = await this.deps.home.mintAppModel(
        entry.owner,
        pool,
        record.label,
        entry.owner,
        signal,
      );
      await this.deps.storage.transaction(async (transaction) => {
        const current = await this.inspect(operationId, transaction);
        if (current?.status !== "started") throw new SlotRefused("selection");
        await this.put({ ...current, keyId: key.keyId }, transaction);
      });
      const response = await (this.deps.fetch ?? fetch)(
        new Request(`https://${brand.host}/v1/models`, {
          headers: {
            authorization: `Bearer ${key.key}`,
            [candidateProbeHeader]: await signEnvelope(
              this.deps.secret,
              deploymentReadinessPrefix,
              record.ticket,
            ),
          },
          redirect: "manual",
          signal,
        }),
      );
      await response.body?.cancel();
      const accepted = await this.inspect(operationId);
      if (response.status !== 200 || accepted?.status !== "accepted")
        throw new SlotRefused("unhealthy");
      return accepted;
    } finally {
      await this.deps.storage.transaction(async (transaction) => {
        const current = await this.inspect(operationId, transaction);
        if (current)
          await this.put(
            {
              ...current,
              status: current.status === "accepted" ? "accepted" : "failed",
              cleanup: true,
            },
            transaction,
          );
      });
      await this.cleanup(operationId).catch(() => this.deps.schedule(this.now() + 5_000));
    }
  }
  async route(request: Request, identity: RefusalIdentity | undefined, beforeDispatch: () => void) {
    const ticket = Schema.decodeUnknownSync(Ticket)(
      await openEnvelope(
        this.deps.secret,
        deploymentReadinessPrefix,
        request.headers.get(candidateProbeHeader) ?? "",
      ),
    );
    const record = await this.inspect(ticket.operationId);
    if (
      !record ||
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/v1/models" ||
      JSON.stringify(ticket.controllerCode) !== JSON.stringify(this.deps.code) ||
      JSON.stringify(record?.ticket) !== JSON.stringify(ticket) ||
      record.status !== "started" ||
      record.cleanup ||
      record.keyId === undefined ||
      identity?.pool !== ticket.pool ||
      identity.keyId !== record.keyId
    )
      throw new SlotRefused("identity");
    await this.current(ticket);
    const headers = new Headers(request.headers);
    headers.delete(candidateProbeHeader);
    const response = await this.deps.forward(
      new Request(request, { headers }),
      ticket.candidate,
      ticket.pool,
      beforeDispatch,
    );
    if (
      response.status !== 200 ||
      response.headers.get("X-Signalbox-Pool-Boot") !== ticket.candidate.bootId
    ) {
      await response.body?.cancel();
      throw new SlotRefused("unhealthy");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SlotRefused("unhealthy");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_000_000) throw new SlotRefused("unhealthy");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(
      JSON.parse(new TextDecoder().decode(body)),
    );
    await this.deps.slots.transact(async (snapshot, transaction) => {
      if (
        snapshot.selection?.epoch !== ticket.expectedEpoch ||
        snapshot.digest !== ticket.policyDigest ||
        !sameIdentity(snapshot.selection.candidate?.identity, ticket.candidate)
      )
        throw new SlotRefused("selection");
      const current = await this.inspect(ticket.operationId, transaction);
      if (current?.status !== "started" || current.cleanup || ticket.expiresAt <= this.now())
        throw new SlotRefused("uncertain");
      const accepted = await this.put(
        { ...current, status: "accepted", acceptedAt: this.now() },
        transaction,
      );
      await transaction.put(servingKey(ticket), accepted);
    });
    return new Response(body, { status: 200, headers: response.headers });
  }
  async assertPromotion(intent: PromotionIntent, transaction: SlotStorage) {
    const raw = await transaction.get(servingKey(intent));
    if (raw === undefined) throw new SlotRefused("unhealthy");
    const record = Schema.decodeUnknownSync(Record)(raw);
    if (
      record.status !== "accepted" ||
      record.acceptedAt === undefined ||
      record.ticket.expiresAt <= this.now() ||
      !sameIdentity(record.ticket.previous, intent.previous) ||
      JSON.stringify(record.ticket.controllerCode) !== JSON.stringify(intent.controllerCode)
    )
      throw new SlotRefused("unhealthy");
  }
  private async cleanup(operationId: string) {
    const record = await this.inspect(operationId);
    if (!record) return;
    for (const keyId of record.keyId === undefined
      ? await this.deps.home.findAppModel(record.label)
      : [record.keyId])
      await this.deps.home.revoke(keyId);
    await this.deps.storage.transaction(async (transaction) => {
      const current = await this.inspect(operationId, transaction);
      if (current) await this.put({ ...current, cleanup: false }, transaction);
      if ((await transaction.get(pendingKey)) === operationId)
        await transaction.put(pendingKey, null);
    });
  }
  async tick() {
    const operationId = await this.deps.storage.get<string>(pendingKey);
    if (!operationId) return;
    const record = await this.inspect(operationId);
    if (!record) throw new SlotRefused("uncertain");
    if (record.cleanup || record.ticket.expiresAt <= this.now()) await this.cleanup(operationId);
  }
  async cancel(operationId: string) {
    await this.deps.storage.transaction(async (transaction) => {
      const record = await this.inspect(operationId, transaction);
      if (!record) throw new SlotRefused("selection");
      await this.put(
        { ...record, status: record.status === "accepted" ? "accepted" : "failed", cleanup: true },
        transaction,
      );
    });
    await this.cleanup(operationId);
    return this.inspect(operationId);
  }
}
