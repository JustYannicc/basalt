/** Author each workflow's destination in the deployed fixture source, as a person edits a copy. */
export function workflowDeliverySource(source, workflows, app) {
  const fields = Object.fromEntries(
    workflows.map((name) => [
      name,
      {
        destination: {
          kind: "tool",
          app,
          tool: "send",
        },
        quietHours: null,
      },
    ]),
  );
  return `${source}\nObject.assign(workflowFields, Object.fromEntries(Object.entries(${JSON.stringify(fields)}).map(([name, fields]) => [name, { ...fields, destination: { ...fields.destination, input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: value => value.receipt } }])));`;
}
