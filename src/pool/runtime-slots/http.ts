import { Schema } from "effect";
import { openEnvelope } from "../token.ts";
import { sameControllerCode, type ControllerCode } from "./contract.ts";
import { decodeRuntimeHandoffCommand, runtimeHandoffCommandPrefix } from "./handoff-command.ts";
import type { RuntimeHandoff } from "./integration.ts";

/** Reuses the private deployment bridge. Commands cannot grant provider-write authority. */
export async function handleRuntimeHandoff(
  request: Request,
  handoff: RuntimeHandoff,
  code: ControllerCode,
  secret: string,
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
    let result: unknown;
    switch (value.action) {
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
