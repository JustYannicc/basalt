import { Schema } from "effect";
import { ControllerCode, SlotRefused, sameControllerCode } from "./contract.ts";
import type { RuntimeActivity } from "./activity.ts";
import type { WitnessRecord } from "./witness-store.ts";

/**
 * How long one adoption holds. The object resets at most once in it, so an instance the platform
 * still serves the old code can't reset in a loop, and a controller still told `adopting` past it
 * stops waiting for the platform.
 */
export const codeAdoptionWindowMs = 30_000;
/** Past this a recorded adoption no longer counts, as for the controller's own handover record. */
const recordTtlMs = 15 * 60_000;
/** The reset waits this long once the answer has left, as a storage restore's session end does. */
const replyAllowanceMs = 250;
const recordKey = "pool-runtime-code-adoption-v1";
const AdoptionRecord = Schema.Struct({
  from: ControllerCode,
  to: ControllerCode,
  /** The last reset. */
  at: Schema.Number,
  /** The first adoption of `to` from `from`, which later resets keep. */
  since: Schema.Number,
});

/** The witness read's answer while its endpoint adopts the controller's code. */
export const CodeAdopting = Schema.Struct({
  kind: Schema.Literal("adopting"),
  controllerCode: ControllerCode,
  since: Schema.Number,
});

interface Dependencies {
  own: ControllerCode;
  role: "legacy" | "runtime";
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  activity: Pick<RuntimeActivity, "inspect">;
  /** Resets this object, so its next event runs the code the platform serves it. */
  abort?(reason: string): void;
  /** Runs once the answer has been handed to the platform. */
  afterReply?(work: () => void): void;
}

/**
 * A fleet cell's endpoint asked by a controller on other code resets itself onto the deployed
 * code, as the controller's own `CodeHandover` resets the controller: only the controller has a
 * handover, and the platform resets other objects on its own schedule, minutes later. The reset
 * runs after the answer, so the answer reaches the controller, and its record outlives the reset.
 */
export class RuntimeCodeAdoption {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  /**
   * Since when this object adopts `to` for the slot `record` holds. The first adoption in a window
   * also resets it. Refuses as `controller_code` when it won't adopt.
   */
  async adopt(record: WitnessRecord, to: ControllerCode) {
    const { abort, own, storage } = this.deps;
    const held = (await this.held(record)) ?? (abort ? undefined : "no_reset");
    if (held || !abort) {
      console.info("POOL_RUNTIME_CODE_ADOPTION", { outcome: "refused", held, from: own, to });
      throw new SlotRefused("controller_code");
    }
    const now = Date.now();
    const raw = await storage.get(recordKey);
    const decoded = raw === undefined ? undefined : Schema.decodeUnknownOption(AdoptionRecord)(raw);
    const last =
      decoded?._tag === "Some" && now - decoded.value.at < recordTtlMs ? decoded.value : undefined;
    const same = !!last && sameControllerCode(last.from, own) && sameControllerCode(last.to, to);
    const since = same ? last.since : now;
    // A fresh instance on the same code finds its predecessor's reset here and waits it out.
    const reset = !last || now - last.at >= codeAdoptionWindowMs;
    const at = last && !reset ? last.at : now;
    // Written before the reset, so the instance after it knows; a failed write resets nothing.
    if (reset || !same) await storage.put(recordKey, { from: own, to, at, since });
    console.info("POOL_RUNTIME_CODE_ADOPTION", {
      outcome: reset ? "resetting" : "waiting",
      from: own,
      to,
      adoptingMs: now - since,
    });
    if (reset)
      (this.deps.afterReply ?? ((work) => void setTimeout(work, replyAllowanceMs)))(() => {
        try {
          abort("code adoption");
        } catch {
          // A reset that throws still ends this instance.
        }
      });
    return since;
  }
  /** Why this object won't reset, or nothing when it may. Each check past the first is a guard. */
  private async held(record: WitnessRecord) {
    // Only a fleet first start adopts.
    if (record.authorization.kind !== "initial-start") return "kind";
    // The controller may already have committed this attestation as its selection.
    if (record.attestation) return "selection";
    // A reset cuts every stream admitted here.
    if (record.identity && ((await this.deps.activity.inspect(record.identity))?.active ?? 0) > 0)
      return "streams";
    // The root's endpoint lives in the controller object, which the controller's handover resets.
    if (this.deps.role === "legacy") return "root";
    return undefined;
  }
}
