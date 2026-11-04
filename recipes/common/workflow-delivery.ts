import { fieldsFor, workflowFields, type WorkflowName } from "./workflow-fields.ts";

export const deliveryConnection = (workflow: WorkflowName) => `alert_${workflow}`;
const dependency = (workflow: WorkflowName) => ({
  scope: "user" as const,
  configuration: {
    tool: "configure",
    policy: { envelope: "self-email", workflow, step: "send configured nudge" },
  },
  tools: { send: { kind: "mutation" as const } },
});

/** Each send step declares its own scope; saved connections still select the exact target account. */
export function deliveryDependencies() {
  return Object.fromEntries<ReturnType<typeof dependency>>(
    (Object.keys(workflowFields) as WorkflowName[]).flatMap((workflow) => {
      const destination = fieldsFor(workflow).destination;
      if (destination.kind !== "self-email") return [];
      return [[deliveryConnection(workflow), dependency(workflow)]];
    }),
  );
}

/** This text is included in the owner's actual configure approval, not only its description. */
export function deliveryScope() {
  return JSON.stringify(
    (Object.keys(workflowFields) as WorkflowName[]).flatMap((workflow) => {
      const destination = fieldsFor(workflow).destination;
      return destination.kind === "self-email"
        ? [
            {
              workflow,
              step: "send configured nudge",
              connection: deliveryConnection(workflow),
              target: destination.app,
              tool: "send",
              account: destination.account,
              to: [destination.recipient],
              cc: [],
              bcc: [],
            },
          ]
        : [];
    }),
  );
}
