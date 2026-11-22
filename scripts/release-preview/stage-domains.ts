/**
 * Rehearsal-only, read-only: the account's Workers custom domains that touch a stage, by its own
 * hostname label or by a Worker its State records. `check` lists them before a destroy has to
 * decide about one. Ids are hashed; a hostname is shown relative to the stage domain only when it
 * sits under the stage's own label, and is never shown otherwise.
 */
import { carriesStage } from "./stage-rootmove.ts";
import { fingerprint } from "./stage-probe.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The names of the Workers a stage's State rows record, the row's and its previous generation's. */
export function stageWorkerNames(rows: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    const value = record(row);
    if (String(value.resourceType ?? "") !== "Cloudflare.Worker") continue;
    for (const generation of [value, record(value.old)]) {
      const name = record(generation.attr).workerName;
      if (typeof name === "string" && name) names.add(name);
    }
  }
  return names;
}

export interface DomainScope {
  /** The stage's DNS label, `rehearsal-<n>`. */
  readonly label: string;
  /** The stage domain; without it no hostname is under the stage's label. */
  readonly domain: string;
  /** The stage, `test-rehearsal-<n>`. */
  readonly stage: string;
  readonly workers: ReadonlySet<string>;
}

export interface DomainFact {
  readonly id: string;
  /** Relative to the stage domain, and only when under the stage's own label. */
  readonly hostname: string | null;
  readonly service: string | null;
  readonly underLabel: boolean;
  readonly serviceInState: boolean;
  readonly serviceStageNamed: boolean;
}

const underLabel = (host: string, scope: DomainScope) =>
  !!scope.domain &&
  (host === `${scope.label}.${scope.domain}` || host.endsWith(`.${scope.label}.${scope.domain}`));

/** Each listed domain that touches the stage by its hostname or its service, with both facts. */
export function domainFacts(domains: readonly unknown[], scope: DomainScope): DomainFact[] {
  const facts: DomainFact[] = [];
  for (const domain of domains.map(record)) {
    const host = typeof domain.hostname === "string" ? domain.hostname.toLowerCase() : "";
    const service = typeof domain.service === "string" ? domain.service : null;
    const fact = {
      underLabel: underLabel(host, scope),
      serviceInState: service !== null && scope.workers.has(service),
      serviceStageNamed: service !== null && carriesStage(service, scope.stage),
    };
    if (!fact.underLabel && !fact.serviceInState && !fact.serviceStageNamed) continue;
    facts.push({
      id: typeof domain.id === "string" ? fingerprint(domain.id) : "unknown",
      hostname: fact.underLabel
        ? `${host.slice(0, -scope.domain.length - 1)}.<stage domain>`
        : null,
      service,
      ...fact,
    });
  }
  return facts;
}

/** Every Workers custom domain in the account, page by page. Reads only. */
export async function readWorkerDomains(
  input: { accountId: string; token: string },
  send: typeof fetch = fetch,
): Promise<unknown[]> {
  const domains: unknown[] = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Cloudflare's Worker domain list did not end");
    const response = await send(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/domains?page=${page}&per_page=100`,
      {
        headers: { Authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok || body.success !== true)
      throw new Error(`Cloudflare's Worker domain list failed with HTTP ${response.status}`);
    const result = Array.isArray(body.result) ? body.result : [];
    domains.push(...result);
    const pages = record(body.result_info).total_pages;
    if (typeof pages !== "number" || page >= pages || result.length === 0) return domains;
  }
}
