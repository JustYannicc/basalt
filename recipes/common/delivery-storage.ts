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
  {
    approval: undefined,
    input: object({ key: string(), episode: number(), question: string(), attempt: string() }),
  },
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
        deliveryAttempt: input.attempt,
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
      attempt: string().optional(),
    }),
  },
  async (ctx: Writer, input) => {
    if (
      !["sent", "uncertain", "refused"].includes(input.status) ||
      (input.receipt?.length ?? 0) > 200
    )
      throw new Error("Invalid delivery receipt.");
    return write(ctx, input.key, (current) =>
      current.episode !== input.episode ||
      !(
        (current.notified === "claimed" &&
          current.deliveryAttempt === undefined &&
          input.attempt === undefined) ||
        (current.notified === "submitted" &&
          input.attempt !== undefined &&
          input.attempt === current.deliveryAttempt)
      )
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
    const scans = ctx.sql
      .exec<{ workflow: string; checkedAt: number; successfulAt: number; known: number }>(
        "SELECT workflow, MIN(checked_at) AS checkedAt, MIN(successful_at) AS successfulAt, MIN(CASE WHEN successful_at >= checked_at THEN 1 ELSE 0 END) AS known FROM scans GROUP BY workflow LIMIT 1001",
      )
      .toArray();
    return {
      configuredAt: current.configured_at,
      current: current.configuration_revision === (await configurationRevision()),
      complete: scans.length <= 1000,
      scans: scans.slice(0, 1000),
      deliveries: ctx.sql
        .exec<{ status: string; at: number }>(
          "SELECT json_extract(state, '$.notified') AS status, MIN(COALESCE(json_extract(state, '$.deliveryAt'), 0)) AS at FROM checkpoints WHERE json_extract(state, '$.open') = 1 AND json_extract(state, '$.notified') != 'none' GROUP BY json_extract(state, '$.notified')",
        )
        .toArray(),
    };
  },
);
