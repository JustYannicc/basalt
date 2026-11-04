export interface WorkflowFields {
  destination:
    | { kind: "approvals" }
    | { kind: "self-email"; app: string; account: string; recipient: string }
    | {
        kind: "tool";
        app: string;
        tool: string;
        input: (message: string, reviewUrl: string) => Record<string, unknown>;
        receipt: (result: unknown) => string | undefined;
      };
  quietHours: null | { timezone: string; startHour: number; endHour: number };
}

/** Each workflow owns these editable fields. Human in the loop always retains its human question. */
export const workflowFields = {
  checkMyConnections: {
    destination: { kind: "approvals" },
    quietHours: { timezone: "Europe/Zurich", startHour: 22, endHour: 8 },
  },
  checkMyPool: { destination: { kind: "approvals" }, quietHours: null },
  checkContributedDepartures: { destination: { kind: "approvals" }, quietHours: null },
  checkProductionRelease: { destination: { kind: "approvals" }, quietHours: null },
  checkPublicAvailability: { destination: { kind: "approvals" }, quietHours: null },
  checkWorkflowHealth: { destination: { kind: "approvals" }, quietHours: null },
  checkPoolRuntime: { destination: { kind: "approvals" }, quietHours: null },
  checkServiceErrors: { destination: { kind: "approvals" }, quietHours: null },
  checkErrorSpike: { destination: { kind: "approvals" }, quietHours: null },
  checkProductionCapacity: { destination: { kind: "approvals" }, quietHours: null },
  checkServiceBudget: { destination: { kind: "approvals" }, quietHours: null },
} satisfies Record<string, WorkflowFields>;
export type WorkflowName = keyof typeof workflowFields;

export function fieldsFor(workflow: WorkflowName): WorkflowFields {
  return workflowFields[workflow];
}
