/** Edit this private copy, then approve its delivery setting and enable its native schedule. */
export const configuration = {
  organization: "",
  /** The existing connected channel app and its exact send tool. No default recipient. */
  channel: null as null | {
    app: string;
    tool: string;
    input: (message: string, reviewUrl: string) => Record<string, unknown>;
    receipt: (result: unknown) => string | undefined;
  },
  quietHours: null as null | { timezone: string; startHour: number; endHour: number },
  /** Empty watches all personal, checkable accounts returned by the authorized inventory. */
  accounts: [] as string[],
  /** Provider IDs come from the pool's view. No provider or plan assumptions are made here. */
  pools: [] as Array<{ app: string; provider: string }>,
  operator: {
    release: null as null | {
      app: string;
      tool: string;
      input: Record<string, unknown>;
      workflowId: number;
      branch: string;
      repository: string;
    },
    availability: null as null | { publicUrl: string },
    workflowApps: [] as string[],
    /** Supply these reads only after verifying a permitted connector's actual metric contract. */
    runtime: null as null | { app: string; tool: string; input: Record<string, unknown> },
    httpErrors: null as null | { app: string; tool: string; input: Record<string, unknown> },
    errorCounts: null as null | { app: string; tool: string; input: Record<string, unknown> },
  },
};
