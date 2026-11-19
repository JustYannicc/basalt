import { Effect } from "effect";

/**
 * What a disposable stage owns, so that a write from it can never land on production. Stages and
 * production share one account, one deploy token, one database organisation and one State store,
 * so only names keep them apart. A stage writes only to what its own State rows record, what this
 * run created, or what is named for the stage; anything else, and any write this module cannot
 * place, is refused.
 */
export interface StageScope {
  readonly stack: string;
  readonly stage: string;
  /** The stage's DNS label (`rehearsal-2`); every hostname it attaches carries it as one label. */
  readonly label: string;
  /** The database-provider databases the stage owns, by name. */
  readonly databases: ReadonlyArray<string>;
  /** The names and ids the stage's own State rows record for the resources they own. */
  readonly owned: ReadonlyArray<string>;
}

export type StageVerdict =
  | { readonly kind: "allow"; readonly creates?: true }
  | { readonly kind: "refuse"; readonly resource: string; readonly field: string }
  /** A Worker or Workflow name only Cloudflare can place: new, or carrying this stage's tags. */
  | { readonly kind: "prove"; readonly family: "Worker" | "Workflow"; readonly name: string };

type Mode = "id" | "worker" | "workflow" | "create" | "free" | "never";
// Paths after `/accounts/{id}`. `id` means the captured segment must be owned.
const ACCOUNT: ReadonlyArray<readonly [RegExp, string, Mode]> = [
  [/^\/workers\/(?:scripts|services|workers)\/([^/]+)/u, "Worker", "worker"],
  [/^\/workers\/assets\/upload$/u, "Worker assets", "free"],
  [/^\/workers\/domains\/([^/]+)$/u, "Worker domain", "id"],
  [/^\/workflows\/([^/]+)/u, "Workflow", "workflow"],
  [/^\/containers\/applications$/u, "container application", "create"],
  [/^\/containers\/applications\/([^/]+)/u, "container application", "id"],
  // Push credentials for the account's registry; stage repositories carry the stage's stack name.
  [/^\/containers\/registries\/[^/]+\/credentials$/u, "container registry", "free"],
  [/^\/hyperdrive\/configs$/u, "Hyperdrive config", "create"],
  [/^\/hyperdrive\/configs\/([^/]+)/u, "Hyperdrive config", "id"],
  [/^\/r2\/buckets$/u, "R2 bucket", "create"],
  [/^\/r2\/buckets\/([^/]+)/u, "R2 bucket", "id"],
  [/^\/d1\/database$/u, "D1 database", "create"],
  [/^\/d1\/database\/([^/]+)/u, "D1 database", "id"],
  [/^\/storage\/kv\/namespaces$/u, "KV namespace", "create"],
  [/^\/storage\/kv\/namespaces\/([^/]+)/u, "KV namespace", "id"],
  [/^\/queues$/u, "Queue", "create"],
  [/^\/queues\/([^/]+)/u, "Queue", "id"],
  [/^\/vectorize\/(?:v2\/)?indexes$/u, "Vectorize index", "create"],
  [/^\/vectorize\/(?:v2\/)?indexes\/([^/]+)/u, "Vectorize index", "id"],
  [/^\/artifacts\/namespaces$/u, "Artifacts namespace", "create"],
  [/^\/artifacts\/namespaces\/([^/]+)/u, "Artifacts namespace", "id"],
  [/^\/tokens$/u, "API token", "create"],
  [/^\/tokens\/([^/]+)/u, "API token", "id"],
  // The account has one Secrets Store, shared with production.
  [/^\/secrets_store(?:\/|$)/u, "Secrets Store", "never"],
];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
const hostOf = (value: unknown) =>
  typeof value === "string"
    ? (value.replace(/^[a-z]+:\/\//u, "").split("/")[0] ?? "").toLowerCase()
    : "";

/**
 * The verdict on one write, from its method, URL and JSON body. Reads (GET, HEAD) are never
 * judged; every other method is, whatever it does. `isOwned` holds what this run created too.
 */
export function stageWriteVerdict(
  scope: StageScope,
  isOwned: (value: string) => boolean,
  method: string,
  url: URL,
  body: unknown,
): StageVerdict {
  const refuse = (resource: string, field = "target"): StageVerdict => ({
    kind: "refuse",
    resource,
    field,
  });
  const labelled = (host: string) => host.split(".").includes(scope.label);
  const path = url.pathname;
  // Alchemy's State store: `/state/stacks/:stack[/stages/:stage/...]`, on its own host.
  const state = /^\/state\/stacks\/([^/]+)(?:\/stages\/([^/]+))?/u.exec(path);
  if (state) {
    const stack = decoded(state[1]!);
    const stage = state[2] === undefined ? url.searchParams.get("stage") : decoded(state[2]);
    // A delete without a stage drops every stage of the stack, production's included.
    return stack === scope.stack && stage === scope.stage
      ? { kind: "allow" }
      : refuse(`State ${stack}/${stage ?? "every stage"}`, "stage");
  }
  const at = path.search(/\/(?:accounts|zones|organizations|user)\//u);
  if (at < 0) return { kind: "allow" };
  const api = path.slice(at);
  const database = /^\/organizations\/[^/]+\/databases(?:\/([^/]+))?/u.exec(api);
  if (database) {
    const name =
      database[1] === undefined
        ? record(body) && typeof body.name === "string"
          ? body.name
          : ""
        : decoded(database[1]);
    return scope.databases.includes(name)
      ? { kind: "allow", ...(database[1] === undefined ? { creates: true as const } : {}) }
      : refuse(`database ${name || "(unnamed)"}`, "database");
  }
  const zone = /^\/zones\/[^/]+(\/.*)?$/u.exec(api);
  if (zone) {
    const rest = zone[1] ?? "";
    const owned = /^\/(?:dns_records|workers\/routes)\/([^/]+)$/u.exec(rest)?.[1];
    if (owned !== undefined)
      return isOwned(decoded(owned)) ? { kind: "allow" } : refuse(`zone record ${decoded(owned)}`);
    if (rest === "/dns_records" && method === "POST")
      return record(body) && labelled(hostOf(body.name))
        ? { kind: "allow", creates: true }
        : refuse(`DNS record ${hostOf(record(body) ? body.name : "")}`, "hostname");
    if (rest === "/workers/routes" && method === "POST")
      return record(body) &&
        labelled(hostOf(body.pattern)) &&
        typeof body.script === "string" &&
        isOwned(body.script)
        ? { kind: "allow", creates: true }
        : refuse(`Worker route ${hostOf(record(body) ? body.pattern : "")}`, "hostname");
    return refuse(`zone path ${rest}`, "path");
  }
  const user = /^\/user\/tokens(?:\/([^/]+))?/u.exec(api);
  if (user)
    return user[1] === undefined
      ? { kind: "allow", creates: true }
      : isOwned(decoded(user[1]))
        ? { kind: "allow" }
        : refuse(`API token ${decoded(user[1])}`);
  const account = /^\/accounts\/[^/]+(\/.*)?$/u.exec(api);
  if (!account) return refuse(`path ${api}`, "path");
  const rest = account[1] ?? "";
  // Attaching a hostname: it must be named for the stage, and the Worker must be the stage's.
  if (rest === "/workers/domains")
    return record(body) &&
      labelled(hostOf(body.hostname)) &&
      typeof body.service === "string" &&
      isOwned(body.service)
      ? { kind: "allow", creates: true }
      : refuse(`Worker domain ${hostOf(record(body) ? body.hostname : "")}`, "hostname");
  for (const [pattern, family, mode] of ACCOUNT) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const name = match[1] === undefined ? "" : decoded(match[1]);
    if (mode === "never") return refuse(family);
    if (mode === "free") return { kind: "allow" };
    if (mode === "create") return { kind: "allow", creates: true };
    if (isOwned(name)) return { kind: "allow" };
    if (mode === "worker") return { kind: "prove", family: "Worker", name };
    if (mode === "workflow") return { kind: "prove", family: "Workflow", name };
    return refuse(`${family} ${name}`);
  }
  return refuse(`account path ${rest}`, "path");
}

// The attributes a provider records as a resource's own name or id. References to what the stage
// shares with production (account, zone, the Secrets Store) never make it the stage's.
const IDENTITY_KEY = /^(?:id|uuid|name|[a-z][A-Za-z]*(?:Id|Name))$/u;
const SHARED_KEYS = new Set(["accountId", "zoneId", "zoneName", "storeId", "organizationId"]);
const SHARED_TYPES = /^Cloudflare\.SecretsStore/u;

/** The own names and ids from a stage's State rows, both generations of an interrupted update. */
export const ownIdentities = (rows: ReadonlyArray<unknown>) => {
  const owned = new Set<string>();
  for (const row of rows) {
    if (!record(row) || SHARED_TYPES.test(String(row.resourceType ?? ""))) continue;
    for (const generation of [row, row.old])
      if (record(generation) && record(generation.attr))
        for (const [key, value] of Object.entries(generation.attr))
          if (
            IDENTITY_KEY.test(key) &&
            !SHARED_KEYS.has(key) &&
            typeof value === "string" &&
            value.length > 0
          )
            owned.add(value);
  }
  return [...owned].sort();
};

interface StateReader {
  list(request: { stack: string; stage: string }): Effect.Effect<ReadonlyArray<string>, unknown>;
  get(request: { stack: string; stage: string; fqn: string }): Effect.Effect<unknown, unknown>;
}

/** Every row of one stack and stage, read once before anything is written. */
export const stageRows = (state: StateReader, stack: string, stage: string) =>
  Effect.gen(function* () {
    const rows: unknown[] = [];
    for (const fqn of yield* state.list({ stack, stage }))
      rows.push(yield* state.get({ stack, stage, fqn }));
    return rows;
  });

/** What a created resource's response and request name, for the run's own set. */
export const createdIdentities = (response: unknown, body: unknown) => {
  const result = record(response) ? response.result : undefined;
  const names = [
    ...(record(result)
      ? Object.entries(result)
          .filter(([key, value]) => IDENTITY_KEY.test(key) && typeof value === "string")
          .map(([, value]) => value as string)
      : []),
    ...(record(body) && typeof body.name === "string" ? [body.name] : []),
  ];
  return names.filter((name) => name.length > 0);
};
