import { Schema } from "effect";
import { openEnvelope } from "../token.ts";
import { sameControllerCode, type ControllerCode, type SlotIdentity } from "./contract.ts";
import { decodeRuntimeHandoffCommand, runtimeHandoffCommandPrefix } from "./handoff-command.ts";
import type { RuntimeHandoff } from "./integration.ts";
import type {
  RuntimeFleetConfiguration,
  FleetConfiguration,
} from "../runtime-fleet/configuration.ts";

export interface HandoffFleet {
  configure(
    operationId: string,
    configuration: FleetConfiguration,
  ): ReturnType<RuntimeFleetConfiguration["configure"]>;
  inspect(operationId?: string): Promise<unknown>;
  disable?(operationId: string, expectedDigest: string): Promise<unknown>;
  assertPrimaryChange?(): Promise<void>;
  replace?(operationId: string, identity: SlotIdentity): Promise<unknown>;
}

/** Reuses the private deployment bridge. Commands cannot grant provider-write authority. */
export async function handleRuntimeHandoff(
  request: Request,
  handoff: RuntimeHandoff,
  code: ControllerCode,
  secret: string,
  fleet?: HandoffFleet,
) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const text = await request.text();
    if (text.length > 256 * 1024) return new Response(null, { status: 413 });
    const { envelope } = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }), {
      onExcessProperty: "error",
    })(JSON.parse(text));
    const value = decodeRuntimeHandoffCommand(
      await openEnvelope(secret, runtimeHandoffCommandPrefix, envelope),
    );
    if (!sameControllerCode(value.controllerCode, code)) return new Response(null, { status: 409 });
    if (
      ["adopt", "stage", "promote", "drain", "discard", "fence", "unfence"].includes(value.action)
    )
      await fleet?.assertPrimaryChange?.();
    let result: unknown;
    switch (value.action) {
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
        result = await handoff.stage(value.proof);
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
  } catch {
    return Response.json({ error: "runtime-handoff-refused" }, { status: 409 });
  }
}
