import {
  mutation,
  number,
  object,
  query,
  string,
  type MutationContext,
  type QueryContext,
} from "apps";
import { configurationRevision } from "./configuration-revision.ts";
import { requirements } from "./installation.ts";
import { controls, write } from "./state.ts";
import type { Checkpoint } from "./types.ts";
type Writer = MutationContext<typeof requirements>;
export const claimNudge = mutation(
  {
    approval: undefined,
    input: object({ key: string(), episode: number(), question: string(), now: number() }),
  },
  async (ctx: Writer, input) => {
    const revision = await configurationRevision();
    let claimed = false;
    write(ctx, input.key, (current, tx) => {
      const controls = tx
        .exec<{ delivery_enabled: number; configuration_revision: string }>(
          "SELECT delivery_enabled, configuration_revision FROM controls WHERE id = 1",
        )
        .one();
      if (controls.delivery_enabled !== 1 || controls.configuration_revision !== revision)
        return current;
      if (
        !current.open ||
        current.episode !== input.episode ||
        current.question?.id !== input.question ||
        current.notified !== "none" ||
        current.declined ||
        current.mutedUntil > input.now ||
        current.observation.verdict !== "action"
      )
        return current;
      claimed = true;
      return {
        ...current,
        revision: current.revision + 1,
        notified: "claimed",
        deliveryAt: Date.now(),
      };
    });
    return claimed;
  },
);
/** The callback acquires this once per actual attempt, outside its replayed step receipt. */
export const beginDelivery = mutation(
  { approval: undefined, input: object({ key: string(), episode: number(), question: string() }) },
  async (ctx: Writer, input) => {
    const revision = await configurationRevision();
    let acquired = false;
    write(ctx, input.key, (current, tx) => {
      const consent = tx
        .exec<{ configuration_revision: string; delivery_enabled: number }>(
          "SELECT configuration_revision, delivery_enabled FROM controls WHERE id = 1",
        )
        .one();
      if (
        consent.configuration_revision !== revision ||
        consent.delivery_enabled !== 1 ||
        current.declined ||
        current.mutedUntil > Date.now()
      )
        return current;
      if (
        !current.open ||
        current.episode !== input.episode ||
        current.question?.id !== input.question ||
        current.notified !== "claimed"
      )
        return current;
      acquired = true;
      return {
        ...current,
        revision: current.revision + 1,
        notified: "submitted",
        deliveryAt: Date.now(),
      };
    });
    return acquired;
  },
);
export const deliveryResult = mutation(
  {
    approval: undefined,
    input: object({
      key: string(),
      episode: number(),
      status: string(),
      receipt: string().optional(),
    }),
  },
  async (ctx: Writer, input) => {
    if (
      !["sent", "uncertain", "refused"].includes(input.status) ||
      (input.receipt?.length ?? 0) > 200
    )
      throw new Error("Invalid delivery receipt.");
    return write(ctx, input.key, (current) =>
      current.episode !== input.episode || !["claimed", "submitted"].includes(current.notified)
        ? current
        : {
            ...current,
            revision: current.revision + 1,
            notified: input.status as Checkpoint["notified"],
            ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
          },
    );
  },
);
/** Health reads expose delivery state, without private targets or channel configuration. */
export const deliveryHealth = query(
  { input: object({}) },
  async (ctx: QueryContext<typeof requirements>) => {
    const current = controls(ctx);
    const rows = ctx.sql
      .exec<{ state: string }>("SELECT state FROM checkpoints LIMIT 1001")
      .toArray();
    return {
      configuredAt: current.configured_at,
      current: current.configuration_revision === (await configurationRevision()),
      complete: rows.length <= 1000,
      deliveries: rows.slice(0, 1000).flatMap(({ state }) => {
        const value: Checkpoint = JSON.parse(state);
        return value.open && value.notified !== "none"
          ? [{ status: value.notified, at: value.deliveryAt ?? 0 }]
          : [];
      }),
    };
  },
);
