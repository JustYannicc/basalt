import type { RuntimeCrashCommand } from "../runtime-crash-contract.ts";
import {
  providerObservationFailureHeader,
  type ProviderObservationTarget,
  type observeBoundProvider,
} from "../runtime-provider/observation.ts";
import { runtimeInput } from "./input.ts";
import { Schema } from "effect";
import { runtimeErrorResponse } from "./request-error.ts";
import { runtimeResponseCause, runtimeResponseDiagnostic } from "../runtime-route-diagnostic.ts";
import type { HomeDatabasePoolObservation } from "../home-database-pool.ts";
import { openEnvelope } from "../token.ts";
import {
  sameControllerCode,
  SlotRefused,
  type ControllerCode,
  type SlotIdentity,
} from "./contract.ts";
import { decodeRuntimeHandoffCommand, runtimeHandoffCommandPrefix } from "./handoff-command.ts";
import type { RuntimeHandoff } from "./integration.ts";
import type {
  RuntimeFleetConfiguration,
  FleetConfiguration,
} from "../runtime-fleet/configuration.ts";
import type { ImageUpdateIntent, RuntimeImageUpdate } from "../runtime-fleet/image-update.ts";
import type { RuntimeCandidateProbe } from "./candidate-probe.ts";
import type { StorageBookmarks } from "../storage-bookmark.ts";

export interface HandoffFleet {
  crash?(command: RuntimeCrashCommand): Promise<unknown>;
  inspectCrash?(identity: SlotIdentity, nonce: string): Promise<unknown>;
  observeProvider?(
    target: ProviderObservationTarget,
    signal?: AbortSignal,
  ): ReturnType<typeof observeBoundProvider>;
  primaryTarget?(
    operationId: string,
    applicationId: string,
  ): Promise<import("./contract.ts").SlotTarget>;
  configure(
    operationId: string,
    configuration: FleetConfiguration,
  ): ReturnType<RuntimeFleetConfiguration["configure"]>;
  inspect(operationId?: string): Promise<unknown>;
  disable?(operationId: string, expectedDigest: string): Promise<unknown>;
  assertPrimaryChange?(action: string): Promise<void>;
  replace?(operationId: string, identity: SlotIdentity): Promise<unknown>;
  prepareImage?(intent: ImageUpdateIntent): ReturnType<RuntimeImageUpdate["prepare"]>;
  inspectImage?(operationId: string): ReturnType<RuntimeImageUpdate["inspect"]>;
  cancelImage?(operationId: string): ReturnType<RuntimeImageUpdate["cancel"]>;
}

/** Reuses the private deployment bridge. Commands cannot grant provider-write authority. */
export async function handleRuntimeHandoff(
  request: Request,
  handoff: RuntimeHandoff,
  code: ControllerCode,
  secret: string,
  fleet?: HandoffFleet,
  probe?: RuntimeCandidateProbe,
  bookmarks?: Pick<StorageBookmarks, "read" | "restore">,
  /** While Sentry refuses the pool's expiry alert: since when and its last status. */
  alertDelivery?: () => Promise<{ refusedSince: number; lastStatus?: number } | undefined>,
  /** The pool's own usage rollup backfill, from the object's storage alone. */
  usageRollup?: () => Promise<unknown>,
) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let command: RefusedCommand | undefined;
  try {
    const text = await request.text();
    if (text.length > 256 * 1024) return new Response(null, { status: 413 });
    const { envelope } = runtimeInput(() =>
      Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }), {
        onExcessProperty: "error",
      })(JSON.parse(text)),
    );
    const value = decodeRuntimeHandoffCommand(
      await openEnvelope(secret, runtimeHandoffCommandPrefix, envelope),
    );
    command = {
      action: value.action,
      // Adopt and stage carry no operation; the candidate commit still ties the line to a release.
      candidate: value.controllerCode.candidate,
      operationId:
        "operationId" in value && typeof value.operationId === "string"
          ? value.operationId
          : "intent" in value
            ? value.intent.operationId
            : null,
    };
    if (!sameControllerCode(value.controllerCode, code)) throw new SlotRefused("identity");
    if (
      [
        "adopt",
        "stage",
        "promote",
        "drain",
        "discard",
        "fence",
        "unfence",
        "startup-abort",
      ].includes(value.action)
    )
      await fleet?.assertPrimaryChange?.(value.action);
    let result: unknown;
    switch (value.action) {
      case "runtime-crash":
        if (!fleet?.crash) throw new SlotRefused("selection");
        result = await fleet.crash(value);
        break;
      case "runtime-crash-inspect":
        if (!fleet?.inspectCrash) throw new SlotRefused("selection");
        result = await fleet.inspectCrash(value.identity, value.nonce);
        break;
      case "storage-bookmark":
        if (!bookmarks) throw new SlotRefused("selection");
        result = await bookmarks.read(value.time);
        break;
      case "storage-restore-bookmark":
        if (!bookmarks) throw new SlotRefused("selection");
        result = await bookmarks.restore(value);
        break;
      case "provider-observe":
        if (!fleet?.observeProvider) throw new Error("Provider observation unavailable");
        result = await fleet.observeProvider(value.target, request.signal);
        break;
      case "candidate-target":
        if (!fleet?.primaryTarget) throw new Error("Runtime fleet unavailable");
        result = await fleet.primaryTarget(value.operationId, value.applicationId);
        break;
      case "candidate-probe":
        if (!probe) throw new Error("Candidate probe unavailable");
        result = await probe.probe(value.operationId, value.pool);
        break;
      case "candidate-probe-inspect":
        if (!probe) throw new Error("Candidate probe unavailable");
        result = await probe.inspect(value.operationId);
        break;
      case "candidate-probe-cancel":
        if (!probe) throw new Error("Candidate probe unavailable");
        result = await probe.cancel(value.operationId);
        break;
      case "image-prepare":
        if (!fleet?.prepareImage) throw new Error("Runtime fleet unavailable");
        result = await fleet.prepareImage(value.update);
        break;
      case "image-inspect":
        if (!fleet?.inspectImage) throw new Error("Runtime fleet unavailable");
        result = await fleet.inspectImage(value.operationId);
        break;
      case "image-cancel":
        if (!fleet?.cancelImage) throw new Error("Runtime fleet unavailable");
        result = await fleet.cancelImage(value.operationId);
        break;
      case "fleet-configure":
        if (!fleet) throw new Error("Runtime fleet unavailable");
        result = await fleet.configure(value.operationId, value.configuration);
        break;
      case "fleet-inspect":
        if (!fleet) throw new Error("Runtime fleet unavailable");
        result = await fleet.inspect(value.operationId);
        break;
      case "fleet-disable":
        if (!fleet?.disable) throw new Error("Runtime fleet unavailable");
        result = await fleet.disable(value.operationId, value.expectedDigest);
        break;
      case "fleet-replace":
        if (!fleet?.replace) throw new Error("Runtime fleet unavailable");
        result = await fleet.replace(value.operationId, value.identity);
        break;
      case "inspect":
        result = {
          ...(await handoff.slots.inspect()),
          recovery: await handoff.recoveryState(),
          lastEnd: await handoff.primaryEnd().catch(() => null),
          // A diagnostic: its read failing must not fail the inspect release flows rely on.
          alertDelivery: (await alertDelivery?.().catch(() => undefined)) ?? null,
          // So is the backfill's state, which a blind monitor would otherwise keep from everyone.
          usageRollup: (await usageRollup?.().catch(() => undefined)) ?? null,
        };
        break;
      case "recovery-reset":
        result = await handoff.resetRecovery();
        break;
      case "active-health":
        result = await handoff.activeHealth();
        break;
      case "receipt":
        result = await handoff.slots.receipt(value.operationId);
        break;
      case "retirement":
        result = await handoff.slots.retirement.inspect(value.operationId);
        break;
      case "witness":
        result = await handoff.witness(value.target);
        break;
      case "adopt":
        result = await handoff.adopt(value.proof);
        break;
      case "stage":
        result = await handoff.beginStage(value.proof);
        break;
      case "startup-abort":
        result = await handoff.startupAbort.abort(value.intent);
        break;
      case "startup-abort-inspect":
        result = await handoff.startupAbort.inspect(value.operationId);
        break;
      case "stage-inspect":
        result = await handoff.staging.inspect(value.target);
        break;
      case "observe":
        result = await handoff.slots.observeCandidate();
        break;
      case "promote":
        result = await handoff.promote(value.intent, value.proof);
        break;
      case "drain":
        result = await handoff.slots.retireDrained(value.operationId);
        break;
      case "discard":
        result = await handoff.slots.discardCandidate(value.operationId);
        break;
      case "fence":
        await handoff.slots.fence(value.identity);
        break;
      case "unfence": {
        const unfenced = await handoff.unfence(value.identity);
        // A slot handed back to recovery may meet a clock that already needs a person.
        result =
          unfenced.by === "recovery"
            ? { ...unfenced, recovery: await handoff.recoveryState() }
            : unfenced;
        break;
      }
      case "peer-bootstrap":
        result = await handoff.bootstrapPeer(value, request.signal);
        break;
    }
    return Response.json({ result: result ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = runtimeErrorResponse(error, "handoff");
    if (response.status === 409)
      logRuntimeCommandRefusal(response, command, handoff.databasePool());
    return response;
  }
}

interface RefusedCommand {
  action: string;
  candidate: string;
  operationId: string | null;
}

/** One closed-vocabulary line per refused command, so a refusal is diagnosable from Workers logs. */
export function logRuntimeCommandRefusal(
  response: Response,
  command: RefusedCommand | undefined,
  homeDatabasePool?: HomeDatabasePoolObservation | null,
) {
  const diagnostic = runtimeResponseDiagnostic(response);
  const runtimeCause = runtimeResponseCause(response);
  const cause = response.headers.get(providerObservationFailureHeader);
  console.warn(
    "POOL_RUNTIME_COMMAND_REFUSED " +
      JSON.stringify({
        action: command?.action ?? null,
        candidate: command?.candidate ?? null,
        operationId: command?.operationId ?? null,
        step: diagnostic?.runtimeStep ?? null,
        reason: diagnostic?.runtimeReason ?? null,
        ...(runtimeCause ? { runtimeCause } : {}),
        ...(homeDatabasePool ? { homeDatabasePool } : {}),
        ...(cause === "provider_observation_refused" || cause === "provider_fetch_failed"
          ? { cause }
          : {}),
      }),
  );
}
