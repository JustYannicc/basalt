/**
 * Read-only: why a standing stage's pool app answers errors. One fresh `view` and one
 * `computerContext` as the smoke user (both queries, nothing mutated), then the events this
 * stage's own Workers logged since, kept privately. A Worker is read only when Alchemy tags it
 * with this stage and its logical id.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewStageOrigin } from "../environment.ts";
import { stageNames, type StageSubject } from "../preview/subject.ts";
import { redactor } from "./redact.ts";
import { stagePoolQueries } from "./stage-model.ts";

/**
 * This stage's Worker for one logical id: the one script Alchemy tagged with this stack, this
 * stage and that id. Names are no evidence (this stage's names do not carry the stage token). None, or more
 * than one, refuses with the sentence the run ends on.
 */
export function stageWorker(
  scripts: readonly { id: string; tags?: readonly string[] }[],
  stage: string,
  logicalId: string,
  stack: string,
) {
  const own = scripts.filter(
    (script) =>
      script.tags?.includes(`alchemy:stack:${stack}`) &&
      script.tags.includes(`alchemy:stage:${stage}`) &&
      script.tags.includes(`alchemy:id:${logicalId}`),
  );
  if (own.length === 0) throw new Error(`There is no ${logicalId} Worker of this stage`);
  if (own.length > 1)
    throw new Error(`${own.length} ${logicalId} Workers carry this stage; none is picked`);
  return own[0]!.id;
}

/** The account's Worker scripts with their tags; a refused list is a failure, never "no Worker". */
export async function workerScripts(account: string, headers: Record<string, string>) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
    { headers },
  );
  if (!response.ok) throw new Error(`The Workers list refused with HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { id: string; tags?: string[] }[] };
  return body.result ?? [];
}

/** One Worker's events whose text carries `needle`, every page up to `max`, newest first. */
async function workerEvents(input: {
  account: string;
  headers: Record<string, string>;
  script: string;
  from: number;
  needle: string;
  max?: number;
}) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.account}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { ...input.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: `rehearsal-diagnose-${Date.now()}`,
        timeframe: { from: input.from, to: Date.now() },
        view: "events",
        limit: input.max ?? 500,
        parameters: {
          filters: [
            { key: "$metadata.service", operation: "eq", type: "string", value: input.script },
          ],
          needle: { value: input.needle, isRegex: false, matchCase: true },
        },
      }),
    },
  );
  const text = await response.text();
  // The start of the error body tells a permission refusal from a bad filter; it is redacted with
  // every other body before it is kept.
  if (!response.ok) return { refused: response.status, body: text.slice(0, 500) };
  const count = (text.match(/"\$metadata"/gu) ?? []).length;
  return { count, body: text.slice(0, 30_000) };
}

/**
 * Read-only, three reads (coordinator 15:42Z): which hop of the stage's own `/pool/v1/*` calls
 * fails. (1) one `computerContext` (and one `view`, whose host cache guard makes the
 * `/pool/v1/changeRevisions` call) as the smoke user; (2) `GET /pool/v1/release` from the runner
 * with no credential, answered by the pool Worker's entry with one controller call; (3) this
 * stage's Router, pool Worker and AppOutbound events for those paths, after 90 s, with the
 * Router's sign-in events as the control that the read sees anything at all.
 */
export async function diagnoseStagePool(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
) {
  const { stage, slug, stack } = stageNames(subject);
  const origin = previewStageOrigin(slug, source.TEST_STAGE_DOMAIN ?? "");
  const from = Date.now();
  const redact = redactor(source);
  const queries = await stagePoolQueries({
    origin,
    stage,
    email: source.PREVIEW_SMOKE_EMAIL ?? "",
    password: source.PREVIEW_SMOKE_PASSWORD ?? "",
  }).catch((error: unknown) => ({
    failed: error instanceof Error ? error.message : String(error),
  }));
  const release = await fetch(new URL("/pool/v1/release", origin), {
    signal: AbortSignal.timeout(30_000),
  }).then(
    async (response) => ({
      status: response.status,
      body: redact(await response.text()).slice(0, 1_200),
    }),
    (error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }),
  );
  // Workers Logs can lag; wait well past a minute before reading them.
  await new Promise((done) => setTimeout(done, 95_000));
  const account = encodeURIComponent(source.CLOUDFLARE_ACCOUNT_ID ?? "");
  const headers = { Authorization: `Bearer ${source.CLOUDFLARE_API_TOKEN ?? ""}` };
  const scripts = await workerScripts(account, headers);
  // Every Worker first: a missing or doubled one ends the run with its sentence, before any event
  // read, and the reads already made stay in the private record.
  let workers: Record<"router" | "poolworker" | "appoutbound" | "api", string>;
  try {
    workers = {
      router: stageWorker(scripts, stage, "Router", stack),
      poolworker: stageWorker(scripts, stage, "PoolWorker", stack),
      appoutbound: stageWorker(scripts, stage, "AppOutbound", stack),
      // On a test stage the upstream Api declares a zone route on the Router's own host
      // (`roleHostRoutes`); its events say whether the app host's /pool/v1 calls reach it instead.
      api: stageWorker(scripts, stage, "Api", stack),
    };
  } catch (error) {
    await writeFile(
      join(outputs, "pool-diagnosis.json"),
      `${JSON.stringify({ at: new Date(from).toISOString(), queries, release, workers: String(error) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
  const reads: Record<string, unknown> = {};
  for (const [label, part, needle] of [
    ["router.signIn (control)", "router", "/api/auth/sign-in/email"],
    ["router.changeRevisions", "router", "/pool/v1/changeRevisions"],
    ["router.setupContext", "router", "/pool/v1/setup-context"],
    ["router.release", "router", "/pool/v1/release"],
    ["poolworker.changeRevisions", "poolworker", "/pool/v1/changeRevisions"],
    ["poolworker.setupContext", "poolworker", "/pool/v1/setup-context"],
    ["poolworker.release", "poolworker", "/pool/v1/release"],
    ["appoutbound.computerContext", "appoutbound", "setup-context"],
    ["appoutbound.changeRevisions", "appoutbound", "changeRevisions"],
    ["api.release", "api", "/pool/v1/release"],
    ["api.changeRevisions", "api", "/pool/v1/changeRevisions"],
  ] as const) {
    reads[label] = await workerEvents({
      account,
      headers,
      script: workers[part],
      from,
      needle,
    }).then((read) =>
      "body" in read && typeof read.body === "string" ? { ...read, body: redact(read.body) } : read,
    );
  }
  const record = { at: new Date(from).toISOString(), queries, release, reads };
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
    release: "status" in release ? release.status : release,
    eventCounts: Object.fromEntries(
      Object.entries(reads).map(([label, read]) => [
        label,
        (read as { count?: number }).count ?? read,
      ]),
    ),
  };
}
