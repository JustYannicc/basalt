import type { WorkflowContext, WorkflowStepContext } from "apps";
import { configurationRevision } from "./configuration-revision.ts";
import { configuration } from "./configuration.ts";
import { api, ReadUnavailable, record, text, tool } from "./api.ts";
import { requirements } from "./installation.ts";
import { quietAt } from "./conditions.ts";
import { claimNudge, deliveryResult } from "./storage.ts";
import type { Checkpoint, Observation } from "./types.ts";
type Flow = WorkflowContext<typeof requirements>;
type Step = WorkflowStepContext<typeof requirements>;
export type ReadAgain = (step: Step, previous: Checkpoint) => Promise<Observation>;
const noRetry = { retries: { limit: 0, delay: "1 second" }, timeout: "15 seconds" } as const;
/** These are pre-execution API refusals. A tool's own error may follow a successful side effect. */
const beforeSubmission = new Set([
  "OrganizationForbidden",
  "ToolBlocked",
  "ToolApprovalRequired",
  "ToolNotFound",
  "ToolKindMismatch",
  "InputInvalid",
  "AccountRequired",
  "AccountNotFound",
  "OAuthReconnectRequired",
  "ToolPolicyFailed",
]);
async function pending(step: Step, question: NonNullable<Checkpoint["question"]>) {
  let after = "";
  while (true) {
    const page = record(
      await api(
        step,
        "GET",
        `workflow-inputs?pending=true${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      ),
    );
    const values = page?.items;
    if (!Array.isArray(values)) return false;
    if (
      values.some((value) => {
        const input = record(value);
        return input?.id === question.id && input.app === question.app;
      })
    )
      return true;
    const next = text(page?.next);
    if (!next || next <= after) return false;
    after = next;
  }
}
export async function nudge(ctx: Flow, key: string, previous: Checkpoint, readAgain: ReadAgain) {
  const question = previous.question;
  if (!question || previous.notified !== "none" || configuration.channel === null)
    return "already-notified";
  const observation = await ctx.step.do("recheck before nudge", (step) =>
    readAgain(step, previous),
  );
  const deliveryAt = await ctx.step.do("delivery clock", async () => Date.now());
  if (observation.verdict !== "action" || quietAt(deliveryAt, configuration.quietHours))
    return "deferred";
  const claimed = await ctx.step.runMutation("claim one nudge", claimNudge, {
    key,
    episode: previous.episode,
    question: question.id,
    now: deliveryAt,
  });
  if (!claimed) return "deferred";
  const result = await ctx.step.do("send configured nudge", noRetry, async (step) => {
    // The provider may accept a send even when its HTTP response or workflow receipt is lost.
    try {
      const consent = record(await tool(step, { app: question.app, tool: "settings", input: {} }));
      const latest = record(
        await tool(step, { app: question.app, tool: "checkpoint", input: { key } }),
      );
      if (
        consent?.deliveryEnabled !== true ||
        consent.revision !== (await configurationRevision()) ||
        latest?.open !== true ||
        record(latest.question)?.id !== question.id ||
        typeof latest.mutedUntil !== "number" ||
        latest.mutedUntil > Date.now()
      )
        return { status: "refused" };
      if (
        !(await pending(step, question)) ||
        (await readAgain(step, previous)).verdict !== "action"
      )
        return { status: "refused" };
      const channel = configuration.channel;
      if (channel === null) return { status: "refused" };
      const result = await tool(
        step,
        {
          app: channel.app,
          tool: channel.tool,
          input: channel.input("A workflow needs your input.", question.reviewUrl),
        },
        "mutation",
      );
      const receipt = channel.receipt(result);
      return receipt && /^[a-zA-Z0-9_.:-]{1,200}$/.test(receipt)
        ? { status: "sent", receipt }
        : { status: "uncertain" };
    } catch (error) {
      return {
        status:
          error instanceof ReadUnavailable &&
          error.reason !== undefined &&
          beforeSubmission.has(error.reason)
            ? "refused"
            : "uncertain",
      };
    }
  });
  await ctx.step.runMutation("save delivery receipt", deliveryResult, {
    key,
    episode: previous.episode,
    ...result,
  });
  return result.status === "uncertain"
    ? "delivery-uncertain"
    : result.status === "refused"
      ? "delivery-refused"
      : "sent";
}
