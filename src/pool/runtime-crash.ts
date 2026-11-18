import { Schema } from "effect";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { signEnvelope } from "./token.ts";
import {
  crashNonceKey,
  currentCrashCommand,
  targetsCell,
  type RuntimeCrashCommand,
} from "./runtime-crash-contract.ts";
import {
  SlotRefused,
  SlotSelection,
  sameIdentity,
  SlotIdentity,
  type SlotTarget,
} from "./runtime-slots/contract.ts";
import type { RuntimeHandoff } from "./runtime-slots/integration.ts";
import { slotSelectionKey, type TransactionStorage } from "./runtime-slots/storage.ts";
import type { RuntimeFleetState } from "./runtime-fleet/state.ts";
import type { RuntimeFleetConfiguration } from "./runtime-fleet/configuration.ts";
import { BoundSlotDriver, type RuntimeStub } from "./runtime-slots/transport.ts";

interface Dependencies {
  storage: TransactionStorage;
  secret: string;
  handoff: RuntimeHandoff;
  state: RuntimeFleetState;
  configuration: RuntimeFleetConfiguration;
  endpoint(identity: SlotTarget): RuntimeStub;
}

/**
 * Fault injection targets the selected primary, or one ready fleet cell that is not the primary.
 * Every other serving runtime stays outside its authority.
 */
export class RuntimeCrash {
  private deps: Dependencies;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async inspect(identity: SlotIdentity, nonce: string) {
    return {
      submission: (await this.deps.storage.get(crashNonceKey(nonce))) ?? null,
      target: await this.deps.handoff.inspectCrash(identity, nonce),
    };
  }
  crash(value: RuntimeCrashCommand) {
    const pending = this.queue.then(() => this.apply(value));
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async apply(value: RuntimeCrashCommand) {
    const command = currentCrashCommand(value);
    const { handoff, storage, state, configuration } = this.deps;
    if (await storage.get(crashNonceKey(command.nonce))) throw new SlotRefused("selection");
    const snapshot = await handoff.storage.inspect();
    const selection = snapshot.selection;
    const cell = targetsCell(command);
    if (
      !selection ||
      selection.candidate ||
      selection.draining ||
      selection.active.fenced ||
      selection.active.retirement
    )
      throw new SlotRefused("identity");
    const namesPrimary = sameIdentity(selection.active.identity, command.identity);
    // A cell packet must not name the primary, and a primary packet must name nothing else.
    if (cell ? namesPrimary : !namesPrimary) throw new SlotRefused("identity");
    const permission = await configuration.inspect();
    if (!permission?.enabled) throw new SlotRefused("selection");
    configuration.assertBindings(permission.configuration);
    if (cell) {
      const row = (await state.inspect()).find((value) =>
        sameIdentity(value.identity, command.identity),
      );
      if (!row) throw new SlotRefused("identity");
      if (row.phase !== "ready")
        throw new SlotRefused(row.phase === "draining" ? "draining" : "unhealthy");
    } else await handoff.activeHealth();
    const driver = new BoundSlotDriver((identity) => this.deps.endpoint(identity));
    const candidates = (await state.inspect()).filter(
      (row) =>
        row.phase === "ready" &&
        row.identity &&
        row.active < permission.configuration.targetActive &&
        row.target.instanceId !== command.identity.instanceId,
    );
    let sibling: SlotIdentity | undefined;
    let capacityExpiresAt = 0;
    for (const row of candidates) {
      const started = Date.now();
      try {
        const health = Schema.decodeUnknownSync(
          Schema.Struct({
            identity: Schema.NullOr(SlotIdentity),
            ready: Schema.Boolean,
            leaseMs: Schema.Number.check(
              Schema.isInt(),
              Schema.isBetween({ minimum: 0, maximum: 1_500 }),
            ),
          }),
        )(await driver.inspectCrash(row.identity!, command.nonce));
        if (!health.ready || !sameIdentity(health.identity ?? undefined, row.identity!)) continue;
        capacityExpiresAt = Math.min(started + 1_000, started + health.leaseMs, command.expiresAt);
        if (capacityExpiresAt <= Date.now()) continue;
        sibling = row.identity;
        break;
      } catch (error) {
        if (!(error instanceof SlotRefused)) throw error;
      }
    }
    if (!sibling && cell) {
      // The primary has no request cap, so it absorbs a cell's traffic whenever it serves.
      const started = Date.now();
      try {
        const health = await handoff.activeHealth();
        capacityExpiresAt = Math.min(started + 1_000, started + health.leaseMs, command.expiresAt);
        if (capacityExpiresAt > Date.now()) sibling = health.identity;
      } catch (error) {
        if (!(error instanceof SlotRefused)) throw error;
      }
    }
    if (!sibling) throw new SlotRefused("unhealthy");
    const checkedAt = Date.now();
    const envelope = await signEnvelope(this.deps.secret, deploymentReadinessPrefix, {
      command,
      sibling,
      checkedAt,
      expiresAt: capacityExpiresAt,
    });
    const submitted = { command, sibling, at: Date.now(), status: "submitted" as const };
    await storage.transaction(async (transaction) => {
      currentCrashCommand(command);
      const current = await configuration.inspect(undefined, transaction);
      const live = await state.inspect(transaction);
      const primary = await transaction.get<unknown>(slotSelectionKey);
      if (
        (await transaction.get(crashNonceKey(command.nonce))) ||
        JSON.stringify(Schema.decodeUnknownSync(SlotSelection)(primary)) !==
          JSON.stringify(selection) ||
        current?.digest !== permission.digest ||
        !current.enabled ||
        (cell &&
          !live.some(
            (row) => row.phase === "ready" && sameIdentity(row.identity, command.identity),
          )) ||
        // An unchanged selection, checked above, is what keeps a primary sibling valid.
        (!sameIdentity(selection.active.identity, sibling!) &&
          !live.some(
            (row) =>
              row.phase === "ready" &&
              sameIdentity(row.identity, sibling!) &&
              row.active < current.configuration.targetActive,
          )) ||
        capacityExpiresAt <= Date.now()
      )
        throw new SlotRefused("selection");
      await transaction.put(crashNonceKey(command.nonce), submitted);
    });
    const receipt = await handoff.crash(command.identity, envelope);
    await storage.put(crashNonceKey(command.nonce), { ...submitted, status: "returned", receipt });
    return receipt;
  }
}
