import { runtimeInput } from "./input.ts";
import { Schema } from "effect";
import { runtimeErrorResponse } from "./request-error.ts";
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

export interface HandoffFleet {
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
) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
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
        result = await handoff.slots.inspect();
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
      case "unfence":
        await handoff.slots.unfence(value.identity);
        break;
      case "peer-bootstrap":
        result = await handoff.bootstrapPeer(value, request.signal);
        break;
    }
    return Response.json({ result: result ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return runtimeErrorResponse(error, "handoff");
  }
}
