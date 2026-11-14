import { Schema } from "effect";
import { awaitProbe } from "../availability.ts";
import { SlotRefused, sameTarget } from "./contract.ts";
import { isLaunchAuthorization } from "./admission-proof.ts";
import type { RuntimeWitnessStore } from "./witness-store.ts";
import type { ControllerState } from "./runtime-state.ts";
import {
  StartupStopIntent,
  StartupStopRecord,
  startupStopKey,
  sameStartupWitness,
} from "./startup-abort-contract.ts";

/** A separate durable fence cannot be erased by a late startup witness write. */
export class RuntimeStartupStop {
  private fenced = new Set<string>();
  private ctx: ControllerState;
  private store: RuntimeWitnessStore;
  constructor(ctx: ControllerState, store: RuntimeWitnessStore) {
    this.ctx = ctx;
    this.store = store;
  }
  assertStart(target: StartupStopIntent["target"]) {
    if (this.fenced.has(startupStopKey(target))) throw new SlotRefused("selection");
  }
  private async read(intent: StartupStopIntent) {
    const raw = await this.ctx.storage.get(startupStopKey(intent.target));
    if (raw === undefined) return undefined;
    const record = Schema.decodeUnknownSync(StartupStopRecord)(raw);
    if (JSON.stringify(record.intent) !== JSON.stringify(intent)) throw new SlotRefused("identity");
    return record;
  }
  async inspect(intent: StartupStopIntent) {
    const record = await this.read(intent);
    if (!record) throw new SlotRefused("uncertain");
    this.fenced.add(startupStopKey(intent.target));
    if (record.status === "aborted") return record;
    if (this.ctx.container!.running) return record;
    const next = { ...record, status: "aborted" as const };
    await this.ctx.storage.put(startupStopKey(intent.target), next);
    return next;
  }
  async abort(value: StartupStopIntent, signal: AbortSignal) {
    const intent = Schema.decodeUnknownSync(StartupStopIntent)(value);
    const prior = await this.read(intent);
    if (prior) return this.inspect(intent);
    const retained = await this.store.retained(intent.target.slotId);
    if (
      !retained ||
      !isLaunchAuthorization(retained.authorization) ||
      retained.authorization.operationId !== intent.startupOperationId ||
      !sameTarget(retained.authorization.target, intent.target) ||
      !sameStartupWitness(intent.witness, retained.witness) ||
      (this.ctx.container!.running && !retained.witness)
    )
      throw new SlotRefused("identity");
    // Fence before yielding so even a queued start cannot cross the physical start call.
    this.fenced.add(startupStopKey(intent.target));
    const record: StartupStopRecord = {
      intent,
      provider: retained.authorization.provider,
      status: "pending",
      destroySent: false,
    };
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(startupStopKey(intent.target))) throw new SlotRefused("uncertain");
      await transaction.put(startupStopKey(intent.target), record);
    });
    if (!this.ctx.container!.running) return this.inspect(intent);
    await this.ctx.storage.put(startupStopKey(intent.target), { ...record, destroySent: true });
    const work = (async () => {
      const monitor = this.ctx.container!.monitor();
      void monitor.catch(() => {});
      await this.ctx.container!.destroy();
      await monitor.catch((error) => {
        if (!(error instanceof Error) || !Schema.is(Schema.Struct({ exitCode: Schema.Int }))(error))
          throw error;
      });
      if (this.ctx.container!.running) throw new SlotRefused("uncertain");
      await this.inspect(intent);
    })();
    this.ctx.waitUntil(work.catch(() => {}));
    try {
      await awaitProbe(() => work, AbortSignal.any([signal, AbortSignal.timeout(2_000)]));
    } catch {
      return this.read(intent);
    }
    return this.inspect(intent);
  }
}
