import type { WorkflowContext } from "apps";
import { api, record, text } from "./api.ts";
import { requirements } from "./installation.ts";
import { nudge, type ReadAgain } from "./delivery.ts";
import {
  attachQuestion,
  checkpoint,
  claimQuestion,
  disposition,
  saveObservation,
  settings,
} from "./storage.ts";
import type { Checkpoint, Observation } from "./types.ts";

type Flow = WorkflowContext<typeof requirements>;
export const clock = (ctx: Flow, name: string) => ctx.step.do(name, async () => Date.now());
export async function withdraw(
  ctx: Flow,
  question: NonNullable<Checkpoint["question"]>,
  label: string,
) {
  return ctx.step.do(label, async (step) => {
    await api(
      step,
      "POST",
      `apps/${encodeURIComponent(question.app)}/workflow-inputs/${encodeURIComponent(question.id)}/withdraw`,
    );
    return { status: "withdrawn" };
  });
}
/** Native pages perform the repair. A saved form response only asks this workflow to verify it. */
const evidenceFor = (observation: Observation) => [
  { label: "Condition", value: observation.code },
  { label: "Observed at", value: new Date(observation.at).toISOString() },
  ...(observation.attemptedSha
    ? [{ label: "Attempted commit", value: observation.attemptedSha }]
    : []),
];
export async function ask(
  ctx: Flow,
  key: string,
  previous: Checkpoint,
  readAgain: ReadAgain,
  link: string,
  label: string,
  workflow: string,
) {
  const now = await clock(ctx, "question clock");
  const claim = await ctx.step.runMutation("claim question", claimQuestion, {
    key,
    episode: previous.episode,
    run: ctx.runId,
    now,
  });
  if (!claim.owned)
    return {
      status: await nudge(ctx, key, claim.state, readAgain),
      code: claim.state.observation.code,
    };
  const question = await ctx.step.requestInput("review resource", {
    timeoutMs: 7 * 86400000,
    evidence: evidenceFor(claim.state.observation),
    form: {
      mode: "form",
      message: `${label}. Condition: ${claim.state.observation.code}. Observed ${new Date(claim.state.observation.at).toISOString()}. Open the existing page to act, then recheck. Saving an answer does not fix the resource.`,
      requestedSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["recheck", "defer"], title: "Next step" },
          minutes: {
            type: "integer",
            minimum: 1,
            maximum: 10080,
            default: 60,
            title: "Minutes to defer",
          },
        },
        required: ["action"],
      },
    },
    links: [
      { label: "Open resource", href: link },
      ...(claim.state.observation.evidenceUrl
        ? [{ label: "Open evidence", href: claim.state.observation.evidenceUrl }]
        : []),
    ],
  });
  if (!question.reviewUrl) throw new Error("This host has no authenticated workflow review route.");
  const attached = await ctx.step.runMutation("attach waiting question", attachQuestion, {
    key,
    episode: claim.state.episode,
    run: ctx.runId,
    id: question.id,
    app: question.app,
    reviewUrl: question.reviewUrl,
  });
  const reference = {
    id: question.id,
    app: question.app,
    reviewUrl: question.reviewUrl,
    run: ctx.runId,
  };
  if (!attached) {
    await withdraw(ctx, reference, "withdraw obsolete question");
    return { status: "obsolete" };
  }
  const state = await ctx.step.runQuery("current waiting state", checkpoint, { key });
  const delivery = await nudge(ctx, key, state, readAgain);
  const response = await ctx.step.waitForInput("wait for the owner", question);
  const answeredAt = await clock(ctx, "answer clock");
  const declined = response.status === "answered" && response.response.action !== "accept";
  const minutes =
    response.status === "answered" &&
    response.response.action === "accept" &&
    response.response.content?.action === "defer"
      ? Number(response.response.content.minutes ?? 60)
      : 0;
  if (response.status !== "answered" || declined || minutes > 0) {
    await ctx.step.runMutation("record decision", disposition, {
      key,
      episode: state.episode,
      run: ctx.runId,
      declined,
      mutedUntil: minutes > 0 ? answeredAt + minutes * 60000 : 0,
    });
    return {
      status: response.status !== "answered" ? response.status : declined ? "declined" : "deferred",
      delivery,
    };
  }
  const currentSettings = await ctx.step.runQuery("settings after answer", settings, {});
  if (!currentSettings.current) return { status: "configuration-changed", delivery };
  const current = await ctx.step.runQuery("state after answer", checkpoint, { key });
  if (!current.open || current.episode !== state.episode) return { status: "obsolete", delivery };
  const verified = await ctx.step.do("verify the resource", (step) => readAgain(step, current));
  const saved = await ctx.step.runMutation("remember verification", saveObservation, {
    key,
    revision: current.revision,
    workflow,
    ...verified,
  });
  if (saved.withdrawn) await withdraw(ctx, saved.withdrawn, "withdraw recovered verification");
  await ctx.step.runMutation("finish verification", disposition, {
    key,
    episode: state.episode,
    run: ctx.runId,
    declined: false,
    mutedUntil: 0,
  });
  return {
    status:
      verified.verdict === "withdraw"
        ? "withdrawn"
        : !saved.state.open
          ? "healthy"
          : "still-needs-action",
    code: saved.state.observation.code,
    delivery,
  };
}
export async function observe(
  ctx: Flow,
  key: string,
  readAgain: ReadAgain,
  link: string,
  label: string,
  workflow: string,
) {
  const currentSettings = await ctx.step.runQuery("check private ownership", settings, {});
  if (!currentSettings.current) return { status: "unconfigured", code: "configuration-changed" };
  const previous = await ctx.step.runQuery("previous observation", checkpoint, { key });
  const observation = await ctx.step.do("read current facts", (step) => readAgain(step, previous));
  const { state, withdrawn } = await ctx.step.runMutation(
    "remember current facts",
    saveObservation,
    { key, revision: previous.revision, workflow, ...observation },
  );
  if (withdrawn) await withdraw(ctx, withdrawn, "withdraw recovered question");
  if (state.open && state.question)
    await ctx.step.do("update waiting evidence", async (step) => {
      const updated = record(
        await api(
          step,
          "POST",
          `apps/${encodeURIComponent(state.question!.app)}/workflow-inputs/${encodeURIComponent(state.question!.id)}/evidence`,
          { evidence: evidenceFor(state.observation) },
        ),
      );
      return { status: text(updated?.status) ?? "unknown" };
    });
  if (!state.open)
    return {
      status:
        observation.verdict === "healthy"
          ? "healthy"
          : observation.verdict === "withdraw"
            ? "withdrawn"
            : "unknown",
      code: observation.code,
    };
  if (observation.verdict !== "action") return { status: "unknown", code: observation.code };
  return ask(ctx, key, state, readAgain, link, label, workflow);
}
