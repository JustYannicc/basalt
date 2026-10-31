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
import { configurationRevision } from "./configuration-revision.ts";
import { requirements } from "./installation.ts";
import { remember, type Checkpoint, type Observation } from "./types.ts";
import { controls, read, write } from "./state.ts";
import { controlTools } from "./controls.ts";
export { settings } from "./controls.ts";
type Writer = MutationContext<typeof requirements>;
const keyInput = object({ key: string() });
export const checkpoint = query(
  { input: keyInput },
  async (ctx: QueryContext<typeof requirements>, { key }) => {
    controls(ctx);
    return read(ctx, key);
  },
);
export const saveObservation = mutation(
  {
    approval: undefined,
    input: object({
      key: string(),
      revision: number(),
      cursor: string(),
      at: number(),
      verdict: string(),
      code: string(),
      failures: number(),
      successes: number(),
      since: number(),
      confirmationCursor: string().optional(),
      openingRate: number().optional(),
      lastUnexpectedAt: number().optional(),
      flapping: boolean().optional(),
      sourceAt: number().optional(),
      evidenceUrl: string().optional(),
      attemptedSha: string().optional(),
    }),
  },
  async (ctx: Writer, input) => {
    if (!["healthy", "action", "unknown", "withdraw"].includes(input.verdict))
      throw new Error("Unknown observation verdict.");
    let withdrawn: Checkpoint["question"];
    const state = write(ctx, input.key, (before) => {
      if (before.revision !== input.revision) return before;
      const observation: Observation = {
        cursor: input.cursor,
        at: input.at,
        verdict: input.verdict as Observation["verdict"],
        code: input.code,
        failures: input.failures,
        successes: input.successes,
        since: input.since,
        ...(input.confirmationCursor === undefined
          ? {}
          : { confirmationCursor: input.confirmationCursor }),
        ...(input.openingRate === undefined ? {} : { openingRate: input.openingRate }),
        ...(input.lastUnexpectedAt === undefined
          ? {}
          : { lastUnexpectedAt: input.lastUnexpectedAt }),
        ...(input.flapping === undefined ? {} : { flapping: input.flapping }),
        ...(input.sourceAt === undefined ? {} : { sourceAt: input.sourceAt }),
        ...(input.evidenceUrl === undefined ? {} : { evidenceUrl: input.evidenceUrl }),
        ...(input.attemptedSha === undefined ? {} : { attemptedSha: input.attemptedSha }),
      };
      const next = remember(before, observation);
      if (before.open && !next.open) withdrawn = before.question;
      return next;
    });
    return { state, withdrawn: withdrawn ?? null };
  },
);
export const claimQuestion = mutation(
  {
    approval: undefined,
    input: object({ key: string(), episode: number(), run: string(), now: number() }),
  },
  async (ctx: Writer, input) => {
    controls(ctx);
    const prior = read(ctx, input.key);
    if (controls(ctx).configuration_revision !== (await configurationRevision()))
      return { owned: false, state: prior };
    let terminal = false;
    if (prior.ownerRun && prior.ownerRun !== input.run) {
      const run = await ctx.workflows.get({ run: prior.ownerRun });
      terminal = ["complete", "errored", "terminated"].includes(run.status);
    }
    let owned = false;
    const state = write(ctx, input.key, (current) => {
      if (
        !current.open ||
        current.episode !== input.episode ||
        current.declined ||
        current.mutedUntil > input.now
      )
        return current;
      if (
        current.ownerRun &&
        current.ownerRun !== input.run &&
        !(terminal && current.ownerRun === prior.ownerRun)
      )
        return current;
      owned = true;
      return { ...current, revision: current.revision + 1, ownerRun: input.run };
    });
    return { owned, state };
  },
);
export const attachQuestion = mutation(
  {
    approval: undefined,
    input: object({
      key: string(),
      episode: number(),
      run: string(),
      id: string(),
      app: string(),
      reviewUrl: string(),
    }),
  },
  async (ctx: Writer, input) => {
    let attached = false;
    write(ctx, input.key, (current) => {
      if (!current.open || current.episode !== input.episode || current.ownerRun !== input.run)
        return current;
      attached = true;
      return {
        ...current,
        revision: current.revision + 1,
        question: { id: input.id, app: input.app, reviewUrl: input.reviewUrl, run: input.run },
      };
    });
    return attached;
  },
);
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
      return { ...current, revision: current.revision + 1, notified: "claimed" };
    });
    return claimed;
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
      current.episode !== input.episode || current.notified !== "claimed"
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
export const disposition = mutation(
  {
    approval: undefined,
    input: object({
      key: string(),
      episode: number(),
      run: string(),
      declined: boolean(),
      mutedUntil: number(),
    }),
  },
  async (ctx: Writer, input) =>
    write(ctx, input.key, (current) => {
      if (current.episode !== input.episode || current.ownerRun !== input.run) return current;
      const { question: _question, ownerRun: _run, ...remaining } = current;
      return {
        ...remaining,
        revision: current.revision + 1,
        declined: input.declined,
        mutedUntil: input.mutedUntil,
      };
    }),
);
export const storageTools = {
  ...controlTools,
  checkpoint,
  saveObservation,
  claimQuestion,
  attachQuestion,
  claimNudge,
  deliveryResult,
  disposition,
};
