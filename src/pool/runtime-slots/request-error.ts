import { Schema } from "effect";
import { PoolSigningFailure } from "../token.ts";
import { PoolDependencyFailure } from "../dependency-failure.ts";
import { ControlFailure } from "../json.ts";
import { PoolRuntimeUnhealthy } from "../lifecycle.ts";
import { FleetRefused } from "../runtime-fleet/state.ts";
import { ProviderObservationRefused } from "../runtime-provider/read.ts";
import {
  runtimeFailureCode,
  runtimeFailureDiagnostic,
  runtimeFailureHeaders,
} from "../runtime-route-diagnostic.ts";
import { SlotRefused } from "./contract.ts";
import { AdoptionReadbackMismatch } from "./adoption-readback.ts";

const defectHeader = "X-Signalbox-Runtime-Defect";

class RemoteRuntimeDefect extends Error {
  readonly requestId: string;
  constructor(requestId: string) {
    super("Runtime request defect");
    this.requestId = requestId;
  }
}

/** Preserve an already logged defect across the private binding without repeating the mutation. */
export function remoteRuntimeDefect(response: Response) {
  const requestId = response.headers.get("X-Request-Id");
  return response.status === 500 &&
    response.headers.get(defectHeader) === "1" &&
    requestId &&
    /^[a-f0-9-]{36}$/u.test(requestId)
    ? new RemoteRuntimeDefect(requestId)
    : undefined;
}

function causeClass(error: unknown) {
  if (Schema.isSchemaError(error)) return "SchemaError";
  if (error instanceof PoolSigningFailure) return "PoolSigningFailure";
  if (error instanceof DOMException) return "DOMException";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "other";
}

export function runtimeErrorResponse(error: unknown, boundary: "handoff" | "endpoint") {
  const provider = error instanceof ProviderObservationRefused;
  const refusal = error instanceof AdoptionReadbackMismatch ? new SlotRefused("identity") : error;
  if (
    refusal instanceof SlotRefused ||
    error instanceof FleetRefused ||
    error instanceof PoolRuntimeUnhealthy ||
    error instanceof PoolDependencyFailure ||
    error instanceof ControlFailure ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    provider
  ) {
    return Response.json(
      {
        error: boundary === "handoff" ? "runtime-handoff-refused" : "runtime-refused",
        reason: provider
          ? error.code
          : runtimeFailureCode(runtimeFailureDiagnostic(refusal, "endpoint_route")),
        ...(provider ? { cause: error.code } : {}),
      },
      { status: 409, headers: runtimeFailureHeaders(refusal, "endpoint_route") },
    );
  }
  const defect =
    error instanceof RemoteRuntimeDefect
      ? error
      : { requestId: crypto.randomUUID(), causeClass: causeClass(error) };
  if (!(error instanceof RemoteRuntimeDefect))
    console.error("POOL_RUNTIME_REQUEST_DEFECT " + JSON.stringify({ ...defect, boundary }));
  return Response.json(
    { error: "runtime-defect", requestId: defect.requestId },
    {
      status: 500,
      headers: {
        ...runtimeFailureHeaders(error, "endpoint_route"),
        "X-Request-Id": defect.requestId,
        [defectHeader]: "1",
        "Cache-Control": "no-store",
      },
    },
  );
}
