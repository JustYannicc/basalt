import {
  boolean,
  mutation,
  number,
  object,
  query,
  string,
  type MutationContext,
  type QueryContext,
} from "apps";
import { always } from "apps/operations/approval";
import { configurationRevision } from "./configuration-revision.ts";
import { requirements } from "./installation.ts";
import { controls, write } from "./state.ts";
type Writer = MutationContext<typeof requirements>;
const keyInput = object({ key: string() });
export const configure = mutation(
  {
    description:
      "Set up this private copy. Delivery remains off unless explicitly enabled. Pausing a schedule stops new scans; turn delivery off or terminate its runs to stop current ones.",
    input: object({ deliveryEnabled: boolean() }),
    approval: always(),
  },
  async (ctx: Writer, input) => {
    const revision = await configurationRevision();
    return ctx.sql.transaction((tx) => {
      if (ctx.user.id === undefined) throw new Error("A personal identity is required.");
      const current = tx
        .exec<{ owner: string | null }>("SELECT owner FROM controls WHERE id = 1")
        .one();
      if (current.owner !== null && current.owner !== ctx.user.id)
        throw new Error("Use your own private copy.");
      tx.exec(
        "UPDATE controls SET owner = ?, configuration_revision = ?, delivery_enabled = ? WHERE id = 1",
        ctx.user.id,
        revision,
        input.deliveryEnabled ? 1 : 0,
      );
      return { deliveryEnabled: input.deliveryEnabled, revision };
    });
  },
);
export const settings = query(
  { input: object({}) },
  async (ctx: QueryContext<typeof requirements>) => {
    const current = controls(ctx);
    return {
      deliveryEnabled: current.delivery_enabled === 1,
      revision: current.configuration_revision,
      current: current.configuration_revision === (await configurationRevision()),
    };
  },
);
export const mute = mutation(
  {
    approval: undefined,
    description: "Snooze this resource until the supplied UTC time. Use unmute to reverse it.",
    input: object({ key: string(), until: number() }),
  },
  async (ctx: Writer, input) =>
    write(ctx, input.key, (current) => ({
      ...current,
      revision: current.revision + 1,
      mutedUntil: input.until,
    })),
);
export const unmute = mutation(
  { approval: undefined, input: keyInput },
  async (ctx: Writer, input) =>
    write(ctx, input.key, (current) => ({
      ...current,
      revision: current.revision + 1,
      mutedUntil: 0,
    })),
);
export const retryRefusedDelivery = mutation(
  {
    description:
      "Retry only a known pre-submission refusal. Uncertain or accepted sends need provider reconciliation and cannot be retried here.",
    input: keyInput,
    approval: always(),
  },
  async (ctx: Writer, input) =>
    write(ctx, input.key, (current) => {
      if (current.notified !== "refused")
        throw new Error("There is no known safe refused delivery to retry.");
      return { ...current, revision: current.revision + 1, notified: "none" };
    }),
);
export const controlTools = { configure, settings, mute, unmute, retryRefusedDelivery };
