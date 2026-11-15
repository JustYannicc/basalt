import { Schema } from "effect";
import { PoolStartupDeadline, PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import type { ControllerCode } from "./runtime-slots/contract.ts";

const operations = new Set([
  "admit",
  "attest",
  "witness",
  "ready",
  "start",
  "observe",
  "health",
  "warm",
  "install",
  "native",
  "retire",
]);
export function runtimeOperation(request: Request) {
  if (request.headers.has("X-Signalbox-Runtime-Identity")) return "forward";
  const operation = new URL(request.url).pathname.slice(1);
  return operations.has(operation) ? operation : "unknown";
}

function causeClass(error: unknown) {
  if (Schema.isSchemaError(error)) return "SchemaError";
  if (error instanceof PoolStartupDeadline) return "PoolStartupDeadline";
  if (error instanceof PoolRuntimeUnhealthy) return "PoolRuntimeUnhealthy";
  if (error instanceof SlotRefused) return "SlotRefused";
  if (error instanceof DOMException) return "DOMException";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "NonError";
}

export function logRuntimeEndpointFailure(
  error: unknown,
  operation: string,
  runtime: ControllerCode & {
    role: "legacy" | "runtime";
    instanceId: string;
    applicationId?: string;
  },
) {
  console.error("POOL_RUNTIME_ENDPOINT_FAILURE", {
    hop: "endpoint_route",
    operation,
    status: 409,
    runtime,
    requestId: crypto.randomUUID(),
    causeClass: causeClass(error),
  });
}
