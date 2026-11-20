/**
 * Read-only: why a standing stage's pool app answers errors. One fresh `view` and one
 * `computerContext` as the smoke user (both queries, nothing mutated), then the events this
 * stage's own Workers logged since, kept privately. A Worker is read only when Alchemy tags it
 * with this stage and its name carries the stage token.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewStageOrigin } from "../environment.ts";
import { stageNames, type StageSubject } from "../preview/subject.ts";
import { redactor } from "./redact.ts";
import { stagePoolQueries } from "./stage-model.ts";

/** The stage's own Workers, by Alchemy's stage tag and the stage token in the name. */
export function ownWorkers(scripts: readonly { id: string; tags?: string[] }[], stage: string) {
  const token = stage.replace(/^test-/u, "");
  return scripts
    .filter((item) => item.tags?.includes(`alchemy:stage:${stage}`) && item.id.includes(token))
    .map((item) => item.id);
}

export async function diagnoseStagePool(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
) {
  const { stage, slug } = stageNames(subject);
  const from = Date.now();
  const queries = await stagePoolQueries({
    origin: previewStageOrigin(slug, source.TEST_STAGE_DOMAIN ?? ""),
    stage,
    email: source.PREVIEW_SMOKE_EMAIL ?? "",
    password: source.PREVIEW_SMOKE_PASSWORD ?? "",
  }).catch((error: unknown) => ({
    failed: error instanceof Error ? error.message : String(error),
  }));
  // Workers Logs land within seconds; wait once before reading them.
  await new Promise((done) => setTimeout(done, 20_000));
  const account = encodeURIComponent(source.CLOUDFLARE_ACCOUNT_ID ?? "");
  const headers = { Authorization: `Bearer ${source.CLOUDFLARE_API_TOKEN ?? ""}` };
  const scripts = (await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
    { headers },
  ).then((response) => response.json())) as { result?: { id: string; tags?: string[] }[] };
  const redact = redactor(source);
  const events: Record<string, unknown> = {};
  for (const script of ownWorkers(scripts.result ?? [], stage)) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          queryId: `rehearsal-diagnose-${Date.now()}`,
          timeframe: { from, to: Date.now() },
          view: "events",
          limit: 30,
          parameters: {
            filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }],
          },
        }),
      },
    );
    const text = await response.text();
    if (!response.ok) events[script] = { refused: response.status };
    else if (/"events"\s*:\s*\[\s*\{/u.test(text)) events[script] = redact(text).slice(0, 20_000);
  }
  const record = { at: new Date(from).toISOString(), queries, events };
  await writeFile(join(outputs, "pool-diagnosis.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    queries:
      "failed" in queries
        ? queries
        : {
            viewFresh: queries.viewFresh.status,
            view: queries.view.status,
            computerContext: queries.computerContext.status,
          },
    workersWithEvents: Object.keys(events).length,
  };
}
