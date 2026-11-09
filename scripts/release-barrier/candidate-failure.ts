import { existsSync } from "node:fs";
import { requiredSecrets } from "../environment.ts";
import { BarrierRefusal } from "./manifest.ts";
import { safeProviderFailure } from "./operation-failure.ts";

export type CandidateStage =
  | "environment"
  | "inputs"
  | "import"
  | "evaluate"
  | "projection"
  | "retirement-auth"
  | "retirement-version"
  | "retirement-state"
  | "retirement-output"
  | "inventory";
const generatedInputs = [
  ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts",
  ".upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts",
  ".upstream/apps/hosted/cloud/.generated/executor-authoring.json",
] as const;
const environmentInputs = [
  ...requiredSecrets,
  "APP_DOMAIN_CONTROLLER_TOKEN",
  "BASALT_RELEASE_ATTEMPT",
] as const;
const causeTags = [
  "MissingInput",
  "InvalidInput",
  "UnclassifiedFailure",
  "ConfigError",
  "HttpClientError",
  "SchemaError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "RequestError",
  "ResponseError",
  "BarrierRefusal",
  "StateStoreError",
  "AuthError",
  "TerminalCancelled",
  "NonInteractiveTerminal",
] as const;
const causeReasons = [
  "missing-compiled-state",
  "forward-probe-mutation-refused",
  "forward-probe-state-write-refused",
  "retirement-state-version-unavailable",
  "retirement-state-version-unsupported",
] as const;
type CandidateReason = (typeof causeReasons)[number];
type CandidateInput = (typeof generatedInputs)[number] | (typeof environmentInputs)[number];

interface CandidateDiagnostics {
  status?: number;
  expectedVersion?: number;
  observedVersion?: number;
}

export class CandidateSettingsReadFailure extends Error {
  readonly _tag = "CandidateSettingsReadFailure";
  readonly stage: CandidateStage;
  readonly tag: (typeof causeTags)[number];
  readonly input: CandidateInput | undefined;
  readonly reason: CandidateReason | undefined;
  readonly diagnostics: CandidateDiagnostics;
  constructor(
    stage: CandidateStage,
    tag: (typeof causeTags)[number],
    input?: CandidateInput,
    reason?: CandidateReason,
    diagnostics: CandidateDiagnostics = {},
  ) {
    super(
      `tag=${tag}; stage=${stage}${input ? `; input=${input}` : ""}${reason ? `; reason=${reason}` : ""}${Object.entries(
        diagnostics,
      )
        .map(([key, value]) => `; ${key}=${value}`)
        .join("")}`,
    );
    this.reason = reason;
    this.diagnostics = diagnostics;
    this.stage = stage;
    this.tag = tag;
    this.input = input;
  }
}

/** Copy closed diagnostics only. Native exception messages can contain configuration and credentials. */
export function candidateReadFailure(error: unknown, stage: CandidateStage) {
  if (error instanceof CandidateSettingsReadFailure) return error;
  const missing =
    error instanceof Error
      ? /^Missing GitHub Actions secret: ([A-Z_]+)$/.exec(error.message)?.[1]
      : undefined;
  const known = environmentInputs.find((input) => input === missing);
  if (known) return new CandidateSettingsReadFailure(stage, "MissingInput", known);
  if (error instanceof Error && error.message === "Release Command attempt identity is missing")
    return new CandidateSettingsReadFailure(stage, "MissingInput", "BASALT_RELEASE_ATTEMPT");
  if (error instanceof Error && error.message === "Invalid release Command attempt identity")
    return new CandidateSettingsReadFailure(stage, "InvalidInput", "BASALT_RELEASE_ATTEMPT");
  const provider = safeProviderFailure(error);
  const name =
    error !== null && typeof error === "object"
      ? (Reflect.get(error, "_tag") ?? Reflect.get(error, "name"))
      : undefined;
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const numeric = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const status = provider.status ?? field(field(error, "http"), "status");
  const versionMessage =
    name === "AuthError" && error instanceof Error
      ? /^Cloudflare State store is out of date \(expected v(\d+), observed v(\d+)\)\./.exec(
          error.message,
        )
      : undefined;
  const expected =
    field(error, "expected") ?? (versionMessage ? Number(versionMessage[1]) : undefined);
  const observed =
    field(error, "observed") ?? (versionMessage ? Number(versionMessage[2]) : undefined);
  return new CandidateSettingsReadFailure(
    stage,
    causeTags.find((tag) => tag === name || tag === provider.type) ?? "UnclassifiedFailure",
    undefined,
    error instanceof BarrierRefusal
      ? causeReasons.find((reason) => reason === error.reason)
      : undefined,
    {
      ...(numeric(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(numeric(expected) ? { expectedVersion: expected } : {}),
      ...(numeric(observed) ? { observedVersion: observed } : {}),
    },
  );
}

export function assertCandidateInputs() {
  const attempt = process.env.BASALT_RELEASE_ATTEMPT;
  if (!attempt)
    throw new CandidateSettingsReadFailure("inputs", "MissingInput", "BASALT_RELEASE_ATTEMPT");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attempt))
    throw new CandidateSettingsReadFailure("inputs", "InvalidInput", "BASALT_RELEASE_ATTEMPT");
  for (const input of generatedInputs)
    if (!existsSync(new URL(`../../${input}`, import.meta.url)))
      throw new CandidateSettingsReadFailure("inputs", "MissingInput", input);
}

export const candidateFailureDetails = (error: CandidateSettingsReadFailure) => ({
  tag: error._tag,
  causeTag: error.tag,
  stage: error.stage,
  ...(error.input ? { input: error.input } : {}),
  ...(error.reason ? { reason: error.reason } : {}),
  ...error.diagnostics,
});
