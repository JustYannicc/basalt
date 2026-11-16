export type SchemaInspectionReason =
  | "schema-inspection-untrusted-context"
  | "schema-inspection-selection-unsupported"
  | "schema-inspection-credentials-unavailable"
  | "schema-inspection-state-unavailable"
  | "schema-inspection-state-version"
  | "schema-inspection-authority-unavailable"
  | "schema-inspection-operation-failed"
  | "schema-inspection-timeout"
  | "schema-inspection-receipt-too-large"
  | "schema-inspection-output-failed";

export class SchemaInspectionRefusal extends Error {
  readonly reason: SchemaInspectionReason;
  constructor(reason: SchemaInspectionReason) {
    super(reason);
    this.reason = reason;
  }
}

export async function withSchemaInspectionContext<A>(
  environment: NodeJS.ProcessEnv,
  candidate: string,
  selection: string,
  work: (context: {
    candidate: string;
    selection: "schema-v1";
    stateUrl: string;
    token: string;
  }) => Promise<A>,
): Promise<A> {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REPOSITORY !== "JustYannicc/basalt" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    candidate !== environment.GITHUB_SHA
  )
    throw new SchemaInspectionRefusal("schema-inspection-untrusted-context");
  if (selection !== "schema-v1")
    throw new SchemaInspectionRefusal("schema-inspection-selection-unsupported");
  const stateUrl = environment.BASALT_PREFLIGHT_STATE_URL;
  const token = environment.BASALT_PREFLIGHT_STATE_TOKEN;
  if (!stateUrl?.trim() || !token?.trim() || token.trim().length < 32 || token.trim().length > 512)
    throw new SchemaInspectionRefusal("schema-inspection-credentials-unavailable");
  return work({ candidate, selection, stateUrl, token });
}
