import { Schema } from "effect";
import {
  SlotIdentity,
  SlotRefused,
  SlotTarget,
  sameIdentity,
  sameTarget,
} from "../runtime-slots/contract.ts";
import type { TransactionStorage, SlotStorage } from "../runtime-slots/storage.ts";
import type { RuntimeFleetState } from "./state.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Replacement = Schema.Struct({
  operationId: Identifier,
  previous: SlotIdentity,
  replacement: SlotTarget,
  status: Schema.Literals(["reserved", "draining", "retired", "cancelled"]),
});
const pendingKey = "runtime-fleet-v1:replacement-pending";
const key = (id: string) => `runtime-fleet-v1:replacement:${id}`;
interface Dependencies {
  storage: TransactionStorage;
  state: RuntimeFleetState;
  target(occupied: readonly SlotTarget[]): Promise<SlotTarget>;
  drain?(identity: SlotIdentity): Promise<unknown>;
}

/** A planned replacement owns its resource reservation before launch and drains only after positive readiness. */
export class RuntimeFleetReplacement {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private async pending(storage: SlotStorage = this.deps.storage) {
    return Schema.decodeUnknownSync(Schema.Array(Identifier))(
      (await storage.get(pendingKey)) ?? [],
    );
  }
  async inspect(operationId: string, storage: SlotStorage = this.deps.storage) {
    Schema.decodeUnknownSync(Identifier)(operationId);
    const value = await storage.get(key(operationId));
    return value === undefined ? undefined : Schema.decodeUnknownSync(Replacement)(value);
  }
  async plan(operationId: string, previous: SlotIdentity) {
    Schema.decodeUnknownSync(Identifier)(operationId);
    const identity = Schema.decodeUnknownSync(SlotIdentity)(previous);
    const retained = await this.inspect(operationId);
    if (retained) {
      if (!sameIdentity(retained.previous, identity)) throw new SlotRefused("identity");
      return retained;
    }
    const rows = await this.deps.state.inspect();
    const row = rows.find((value) => sameIdentity(value.identity, identity));
    if (!row || row.phase !== "ready") throw new SlotRefused("selection");
    const replacement = await this.deps.target(rows.map((value) => value.target));
    const record = { operationId, previous: identity, replacement, status: "reserved" as const };
    await this.deps.state.reserve(replacement, async (transaction) => {
      if (await this.inspect(operationId, transaction)) throw new SlotRefused("uncertain");
      const current = (await this.deps.state.inspect(transaction)).find((value) =>
        sameIdentity(value.identity, identity),
      );
      if (!current || current.phase !== "ready") throw new SlotRefused("selection");
      const pending = await this.pending(transaction);
      for (const id of pending) {
        if (sameIdentity((await this.inspect(id, transaction))?.previous, identity))
          throw new SlotRefused("selection");
      }
      await transaction.put(key(operationId), record);
      await transaction.put(pendingKey, [...pending, operationId]);
    });
    return record;
  }
  async keepReady(identity: SlotIdentity) {
    for (const id of await this.pending()) {
      const record = await this.inspect(id);
      if (record?.status === "reserved" && sameIdentity(record.previous, identity)) return true;
    }
    return false;
  }
  async upkeep() {
    for (const id of await this.pending()) {
      const record = await this.inspect(id);
      if (!record) throw new SlotRefused("uncertain");
      const rows = await this.deps.state.inspect();
      const next = rows.find((value) => sameTarget(value.target, record.replacement));
      if (record.status === "reserved" && next?.phase === "ready" && next.identity) {
        if (this.deps.drain) await this.deps.drain(record.previous);
        else await this.deps.state.drain(record.previous);
        await this.deps.storage.put(key(id), { ...record, status: "draining" });
      } else if (
        record.status === "draining" &&
        !rows.some((value) => sameIdentity(value.identity, record.previous))
      ) {
        await this.deps.storage.transaction(async (transaction) => {
          await transaction.put(key(id), { ...record, status: "retired" });
          await transaction.put(
            pendingKey,
            (await this.pending(transaction)).filter((value) => value !== id),
          );
        });
      }
    }
  }
  async cancel() {
    await this.deps.storage.transaction(async (transaction) => {
      for (const id of await this.pending(transaction)) {
        const record = await this.inspect(id, transaction);
        if (!record) throw new SlotRefused("uncertain");
        await transaction.put(key(id), { ...record, status: "cancelled" });
      }
      await transaction.put(pendingKey, []);
    });
  }
}
