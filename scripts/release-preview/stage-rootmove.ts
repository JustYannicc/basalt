/**
 * Rehearsal-only reads for the `rootmove` mode: a lane's root application moves to another image
 * through a plain Alchemy deploy while its instance runs. These say what that did to the running
 * instance, read-only from Cloudflare's own lists, with every id hashed.
 */
import { fingerprint } from "./stage-probe.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export interface RootInstance {
  readonly id: string | null;
  readonly state: string | null;
  /** Any field the instance list states a version in, as Cloudflare names it. */
  readonly versions: Record<string, string | number>;
}
export interface RootRead {
  readonly version: string | number | null;
  readonly instances: readonly RootInstance[];
}

/** One instance as the list states it: its id hashed, its state, and any version it carries. */
export function instanceFacts(instance: unknown): RootInstance {
  const value = record(instance);
  const versions: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(value))
    if (/version/iu.test(key) && (typeof field === "string" || typeof field === "number"))
      versions[key] = field;
  const state = record(value.status).state;
  return {
    id: typeof value.id === "string" ? fingerprint(value.id) : null,
    state: typeof state === "string" ? state : null,
    versions,
  };
}

const running = (read: RootRead) =>
  read.instances.filter((instance) => instance.state === "running").map(({ id }) => id);

/**
 * (a): the application took a new version, while the one instance that ran before the move still
 * runs and the root's boot never changed. (c): no boot change means no restart, so nothing the
 * instance served was cut. An instance list that does not show exactly one running instance
 * before the move proves neither.
 */
export function rootMoveVerdict(input: {
  before: RootRead;
  after: RootRead;
  rootChanged: boolean;
}) {
  const [instance, ...others] = running(input.before);
  const sameRunningInstance =
    instance !== undefined && others.length === 0 && running(input.after).includes(instance);
  const versionMoved =
    input.before.version !== null &&
    input.after.version !== null &&
    input.before.version !== input.after.version;
  return {
    versionMoved,
    sameRunningInstance,
    bootUnchanged: !input.rootChanged,
    a: versionMoved && sameRunningInstance && !input.rootChanged,
    c: sameRunningInstance && !input.rootChanged,
  };
}

/** The root application's version and its instances, by the application's name. Reads only. */
export async function readRootApplication(
  input: { accountId: string; token: string; name: string },
  send: typeof fetch = fetch,
): Promise<RootRead> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/containers/applications`;
  const headers = { Authorization: `Bearer ${input.token}` };
  const get = async (url: string) => {
    const response = await send(url, { headers, signal: AbortSignal.timeout(30_000) });
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok || body.success !== true)
      throw new Error(`Cloudflare container read failed with HTTP ${response.status}`);
    return body;
  };
  const listed = await get(base);
  const application = (Array.isArray(listed.result) ? listed.result : [])
    .map(record)
    .find((value) => value.name === input.name);
  if (!application || typeof application.id !== "string")
    throw new Error("The root application is not in the account's list");
  const instances: RootInstance[] = [];
  let page: string | undefined;
  for (let count = 0; ; count++) {
    if (count >= 100) throw new Error("Cloudflare's instance list did not end");
    const query = new URLSearchParams({ per_page: "100", ...(page ? { page_token: page } : {}) });
    const body = await get(`${base}/${encodeURIComponent(application.id)}/instances-v2?${query}`);
    for (const instance of Array.isArray(body.result) ? body.result : [])
      instances.push(instanceFacts(instance));
    const next = record(body.result_info).next_page_token;
    if (typeof next !== "string" || !next) break;
    page = next;
  }
  const version = application.version;
  return {
    version: typeof version === "string" || typeof version === "number" ? version : null,
    instances,
  };
}
