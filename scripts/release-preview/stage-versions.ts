/**
 * Read-only: how many versions of the stage's pool Worker an apply created (lane 5: a release that
 * leaves the pool Worker's code unchanged uploads none, one that changes it uploads exactly one).
 * The Worker is found by its stack, stage and logical-id tags; versions are counted by their
 * creation time inside the apply's window. Version ids stay private; counts go public.
 */
import { stageWorker, workerScripts } from "./stage-diagnose.ts";

type Version = { id?: unknown; number?: unknown; metadata?: { created_on?: unknown } };

/** The versions whose creation falls inside [from, to], oldest first. */
export function versionsCreatedBetween(versions: readonly Version[], from: number, to: number) {
  return versions
    .map((version) => ({
      id: typeof version.id === "string" ? version.id : "",
      number: typeof version.number === "number" ? version.number : null,
      at: Date.parse(String(version.metadata?.created_on ?? "")),
    }))
    .filter((version) => version.id && Number.isFinite(version.at))
    .filter((version) => version.at >= from && version.at <= to)
    .sort((a, b) => a.at - b.at);
}

export async function poolWorkerVersionsBetween(input: {
  account: string;
  headers: Record<string, string>;
  stage: string;
  stack: string;
  from: number;
  to: number;
  fetch?: typeof fetch;
}) {
  const send = input.fetch ?? fetch;
  const script = stageWorker(
    await workerScripts(input.account, input.headers),
    input.stage,
    "PoolWorker",
    input.stack,
  );
  const all: Version[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await send(
      `https://api.cloudflare.com/client/v4/accounts/${input.account}/workers/scripts/${encodeURIComponent(script)}/versions?page=${page}&per_page=100`,
      { headers: input.headers },
    );
    if (!response.ok)
      throw new Error(`The Worker versions list refused with HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: { items?: Version[] } | Version[];
      result_info?: { total_pages?: number };
    };
    const items = Array.isArray(body.result) ? body.result : (body.result?.items ?? []);
    all.push(...items);
    const pages = body.result_info?.total_pages;
    if (typeof pages === "number" ? page >= pages : items.length < 100) break;
  }
  const created = versionsCreatedBetween(all, input.from, input.to);
  return { script, count: created.length, numbers: created.map((version) => version.number) };
}
