import { existsSync } from "node:fs";
import { requiredSecrets } from "../environment.ts";
import { safeProviderFailure } from "./operation-failure.ts";

export type CandidateStage =
  | "environment"
  | "inputs"
  | "import"
  | "evaluate"
  | "projection"
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
] as const;
type CandidateInput = (typeof generatedInputs)[number] | (typeof environmentInputs)[number];

export class CandidateSettingsReadFailure extends Error {
  readonly _tag = "CandidateSettingsReadFailure";
  readonly stage: CandidateStage;
  readonly tag: (typeof causeTags)[number];
  readonly input: CandidateInput | undefined;
  constructor(stage: CandidateStage, tag: (typeof causeTags)[number], input?: CandidateInput) {
    super(`tag=${tag}; stage=${stage}${input ? `; input=${input}` : ""}`);
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
  return new CandidateSettingsReadFailure(
    stage,
    causeTags.find((tag) => tag === provider.type) ?? "UnclassifiedFailure",
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
});
