import { Data } from "effect";
import { AcceptanceFailure } from "../pool-acceptance/types.ts";

/** Every refusal names the exact field and values, plus what to change. Messages never carry secrets. */
export class FleetLaneRefused extends Data.TaggedError("FleetLaneRefused")<{
  readonly reason: string;
  readonly why: string;
  readonly fix: string;
}> {
  override get message() {
    return `${this.reason}: ${this.why} Fix: ${this.fix}`;
  }
}

export const refuse = (reason: string, why: string, fix: string) =>
  new FleetLaneRefused({ reason, why, fix });

/** The lane's own closed step names: a failure says where it happened, never the error's text. */
export type FleetStep =
  | "inspect"
  | "primary_read"
  | "settings_read"
  | "application_read"
  | "send"
  | "inspect_after"
  | "digest";

export class FleetStepFailed extends Data.TaggedError("FleetStepFailed")<{
  readonly step: FleetStep;
  readonly failure: unknown;
}> {}

/** A typed refusal already says what and why; anything else is tagged with the step it failed in. */
export const atStep = (step: FleetStep, error: unknown) =>
  error instanceof FleetLaneRefused || error instanceof FleetStepFailed
    ? error
    : new FleetStepFailed({ step, failure: error });

/** The account id is public-repo sensitive; every output passes through this before it leaves. */
export function redact<T>(value: T, secrets: readonly string[]): T {
  const hidden = secrets.filter((secret) => secret.length >= 8);
  if (!hidden.length) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, field: unknown) =>
      typeof field === "string"
        ? hidden.reduce((text, secret) => text.split(secret).join("redacted"), field)
        : field,
    ),
  ) as T;
}

const published = new Set([
  "handoff.command.action",
  "handoff.response.http",
  "handoff.response.step",
  "handoff.response.reason",
  "handoff.response.code",
]);
// A status is a closed number: it says whether the Worker or the bridge in front of it answered.
const closed = (value: unknown) =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);

export function describeError(error: unknown): string {
  // Acceptance messages are written for public CI logs; they never carry bodies or secrets.
  if (error instanceof FleetLaneRefused || error instanceof AcceptanceFailure) return error.message;
  if (error instanceof FleetStepFailed)
    return `${describeError(error.failure)} at step ${error.step}`;
  // Bridge and SDK messages can name the account or Worker; only the class and fixed reason leave.
  const reason =
    error !== null && typeof error === "object" && "reason" in error ? error.reason : undefined;
  const name = error instanceof Error ? error.constructor.name : "UnknownError";
  // The bridge keeps only the controller's closed refusal vocabulary under handoff.response.*.
  const changed =
    error !== null && typeof error === "object" && "delta" in error
      ? (error.delta as { changed?: { path: string; new: unknown }[] } | undefined)?.changed
      : undefined;
  const response = (changed ?? [])
    .filter((entry) => published.has(entry.path) && closed(entry.new))
    .map((entry) => `${entry.path}=${String(entry.new)}`)
    .join(" ");
  const base = typeof reason === "string" ? `${name}: ${reason}` : name;
  return response ? `${base} (${response})` : base;
}
