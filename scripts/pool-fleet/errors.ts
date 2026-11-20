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
  "handoff.response.step",
  "handoff.response.reason",
  "handoff.response.code",
]);

export function describeError(error: unknown) {
  // Acceptance messages are written for public CI logs; they never carry bodies or secrets.
  if (error instanceof FleetLaneRefused || error instanceof AcceptanceFailure) return error.message;
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
    .filter((entry) => published.has(entry.path) && typeof entry.new === "string")
    .map((entry) => `${entry.path}=${String(entry.new)}`)
    .join(" ");
  const base = typeof reason === "string" ? `${name}: ${reason}` : name;
  return response ? `${base} (${response})` : base;
}
