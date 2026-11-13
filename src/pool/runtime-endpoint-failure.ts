import { Schema } from "effect";
import { redactLogText } from "../telemetry/log-redaction.ts";
import type { EndpointEnvironment } from "./runtime-slots/endpoint.ts";
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

export function logRuntimeEndpointFailure(
  error: unknown,
  operation: string,
  runtime: ControllerCode & {
    role: "legacy" | "runtime";
    instanceId: string;
    applicationId?: string;
  },
  env: EndpointEnvironment,
) {
  const secrets = [
    env.POOL_DATABASE_URL,
    env.POOL_MANAGEMENT_KEY,
    env.POOL_APP_SIGNING_KEY,
    env.POOL_APP_SIGNING_KEY_PREVIOUS,
    env.POOL_DEPLOYMENT_KEY,
  ]
    .filter((value): value is string => !!value)
    .sort((left, right) => right.length - left.length);
  const redact = (value: string, limit: number) =>
    redactLogText(
      secrets
        .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@"),
    ).slice(0, limit);
  // Decoder errors embed input excerpts; retain their type and frames without that content.
  const inputError = error instanceof SyntaxError || Schema.isSchemaError(error);
  const message =
    error instanceof Error
      ? inputError
        ? "Runtime input decoding failed"
        : error.message
      : "Non-Error exception";
  console.error("POOL_RUNTIME_ENDPOINT_FAILURE", {
    hop: "endpoint_route",
    operation,
    status: 409,
    runtime,
    exception:
      error instanceof Error
        ? {
            class: redact(error.constructor.name, 128),
            name: redact(error.name, 128),
            message: redact(message, 2048),
            ...(error.stack
              ? {
                  stack: redact(
                    inputError
                      ? [
                          message,
                          ...error.stack.split("\n").filter((line) => /^\s+at\s/.test(line)),
                        ].join("\n")
                      : error.stack,
                    8192,
                  ),
                }
              : {}),
          }
        : { class: typeof error, name: "NonError", message },
  });
}
