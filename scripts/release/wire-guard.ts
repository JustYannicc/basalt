/**
 * Wire guard: the deploy process's own outgoing HTTP refuses Durable Object class changes, deletes
 * of data-holding resources, and a class change that ships unreviewed code, before a byte leaves.
 * A class change cannot be rolled back, so the upload that carries one must re-send the exact code
 * that is serving; and the guard must cover every route a deploy sends through, or it proves nothing.
 *
 * Why a global wrap, a layer and a self-test (effect 4.0.1, alchemy 2.0.0-beta.80):
 * - Alchemy's deploy platform and its PlanetScale provider send through `FetchHttpClient.layer`
 *   (alchemy/src/Stack.ts:363-366, alchemy/src/Planetscale/Providers.ts:70), and so does distilled.
 * - That client reads `fiber.getRef(Fetch)` on every request (effect/src/http/FetchHttpClient.ts:57),
 *   so a `Fetch` in context wins for everything below it: `guard.layer`.
 * - With none in context the reference falls back to `globalThis.fetch`, and Context caches that
 *   default on its first read for the life of the process (effect/src/Context.ts:1615-1621). A wrap
 *   of the global after that read is bypassed, so `install` runs before anything sends and
 *   `selfTest` probes both routes.
 */
import { createHash } from "node:crypto";
import { Cause, Data, Deferred, Effect, Exit, Layer, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  createdIdentities,
  stageWriteVerdict,
  type StageScope,
  type StageVerdict,
} from "./stage-writes.ts";
import { bindingShapes, differingBindings } from "./fixed-bindings.ts";

export class WireRefused extends Data.TaggedError("WireRefused")<{
  readonly resource: string;
  readonly method: string;
  readonly path: string;
  readonly field: string;
  readonly value: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return `wire guard refused ${this.method} ${this.path} (${this.resource}): ${this.field} = ${this.value}. ${this.why} Fix: ${this.fix}`;
  }
}

export class WireGuardSelfTestFailed extends Data.TaggedError("WireGuardSelfTestFailed")<{
  readonly route: "context" | "default";
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}

export interface WireGuardConfig {
  /** Classes each script (by name) may add as `new_sqlite_classes`; none by default. */
  readonly sqliteClasses?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Disposable stages only: a first deploy creates every class; creating one never loses data. */
  readonly anyNewSqliteClass?: boolean;
  /**
   * Expected sha256 (hex) of each script's uploaded main module. An upload that adds an allow-listed
   * SQLite class is refused unless its script has one: the class change must not move code with it.
   */
  readonly mainModuleSha256?: Readonly<Record<string, string>>;
  /**
   * Container applications no request may change: the legacy root. Alchemy patches and rolls out an
   * application whenever its desired configuration differs from the recorded one, including env it
   * derives from bindings, which the plan does not show. A rollout restarts the root's master Home.
   */
  readonly rootApplications?: ReadonlyArray<string>;
  /**
   * The root application's recorded name. Alchemy finds an application by name when the recorded id
   * is stale, so an application read that answers with this name adds its id to the held set.
   */
  readonly rootApplicationNames?: ReadonlyArray<string>;
  /**
   * Destroy of a disposable stage only: the names and ids its destroy plan records for the
   * resources it deletes. A delete of exactly one of them is admitted; every other stays refused.
   */
  readonly deletable?: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
  /** A disposable stage: every write must target what the stage owns (`stage-writes.ts`). */
  readonly stage?: StageScope;
  /** A read of production (plan, preflight, counts): every method but GET and HEAD is refused. */
  readonly readOnly?: boolean;
  /**
   * Scripts a policy admits as a code-only change, with their serving version's binding shapes
   * (`fixed-bindings.ts`). An upload of one must carry exactly those bindings and no migration.
   */
  readonly fixedBindings?: Readonly<Record<string, ReadonlyArray<string>>>;
}
export interface JournalEntry {
  readonly method: string;
  readonly host: string;
  readonly path: string;
}

const BY_HAND = "Do it by hand under its own approval, never inside a deploy.";
const REASONS = {
  unparsable: ["Unreadable upload metadata could carry any class change.", "Send JSON metadata."],
  malformed: ["The metadata does not have the shape the class checks read.", "Fix the uploader."],
  change: ["This drops, moves or creates non-SQLite Durable Object storage.", BY_HAND],
  sqlite: ["A new class outside this script's reviewed allow-list.", "Review it into the list."],
  export: ["A non-live export deletes, renames or transfers a namespace.", BY_HAND],
  main: ["The main module is not in the upload, so its hash cannot be checked.", "Upload it."],
  hash: ["The code differs from the reviewed build.", "Rebuild from the reviewed commit."],
  pinned: [
    "A new class cannot be rolled back, so the upload that adds it must carry the serving code byte for byte, and nothing pinned that code.",
    "Configure the script's live main module digest before the class change.",
  ],
  application: [
    "Only an application this process created, or one with no Durable Object attachment and no active instance (an attachment-less precreate a killed apply left behind), may be deleted.",
    BY_HAND,
  ],
  delete: ["Deleting it loses data or breaks the live service.", BY_HAND],
  fixed: [
    "This Worker is released as a code-only change: its upload must carry the serving version's bindings and no migration, or its Durable Object classes and attachments move with code a rollback cannot undo.",
    "Ship the binding or class change in its own reviewed release.",
  ],
  root: [
    "Alchemy found a configuration difference on the root application, and a PATCH or rollout restarts the root and its master Home.",
    "Make the declaration match the recorded application, or restart the root in its own named step.",
  ],
  store: [
    "A deploy must never redeploy the shared State store or rewrite a Secrets Store secret; that rotates the store token every stack reads.",
    "Upgrade or bootstrap the store by hand under its own approval.",
  ],
  readonly: [
    "This run only reads production, so it sends nothing but reads; this request would write.",
    "Find what tried to write during a read. A plan, preflight or count never writes.",
  ],
  stage: [
    "A disposable stage shares the account, the deploy token and the State store with production, so it may write only what it owns: what its own State rows record, what this run created, or what is named for the stage. This target is none of those, or the guard cannot place it.",
    "If the target is the stage's, name it for the stage or let the stage create it. If it is a new kind of write, teach stage-writes.ts to place it. Never point a stage at a shared resource.",
  ],
} as const;
interface At {
  readonly resource: string;
  readonly method: string;
  readonly path: string;
}
const refuse = (
  at: At,
  rule: keyof typeof REASONS,
  field: string,
  value: string,
  cause?: unknown,
) => new WireRefused({ ...at, field, value, why: REASONS[rule][0], fix: REASONS[rule][1], cause });

// Path words kept in the journal; every other segment (accounts, names, ids) prints as {id}.
const WORDS = new Set(
  "client v1 v2 v4 accounts zones organizations workers scripts services environments versions deployments content settings script-settings edge-preview previews subdomain secrets schedules tails durable_objects namespaces objects containers applications rollouts instances registries hyperdrive configs r2 buckets d1 database query secrets_store stores databases branches roles passwords backups assets upload assets-upload-session routes domains queues consumers purge messages workflows storage kv bulk delete values vectorize indexes delete_by_ids artifacts repos tokens user".split(
    " ",
  ),
);
const template = (path: string) =>
  path.replace(/[^/]+/g, (segment) => (WORDS.has(segment) ? segment : "{id}"));
// Strip any base prefix (/client/v4, /v1) so local test servers and production match alike.
const apiPath = (pathname: string) =>
  pathname.slice(Math.max(0, pathname.search(/\/(accounts|organizations|user)\//)));

const UPLOAD =
  /^\/accounts\/[^/]+\/workers\/(?:scripts|workers|services)\/([^/]+)(?:\/environments\/[^/]+)?(?:\/(?:versions|content|settings|edge-preview|previews(?:\/[^/]+\/deployments)?))?$/;
const PROTECTED: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/accounts\/[^/]+\/workers\/(?:scripts|workers|services)\/([^/]+)/, "Worker"],
  [/^\/accounts\/[^/]+\/hyperdrive\/configs\/([^/]+)/, "Hyperdrive config"],
  [/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)/, "R2 bucket"],
  [/^\/accounts\/[^/]+\/d1\/database\/([^/]+)/, "D1 database"],
  [/^\/accounts\/[^/]+\/(?:workers\/)?durable_objects\/namespaces\/([^/]+)/, "DO namespace"],
  [/^\/accounts\/[^/]+\/secrets_store\/stores\/([^/]+)/, "Secrets Store store"],
  [/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)/, "KV namespace"],
  [/^\/accounts\/[^/]+\/queues\/([^/]+)/, "Queue"],
  [/^\/accounts\/[^/]+\/vectorize\/(?:v2\/)?indexes\/([^/]+)/, "Vectorize index"],
  [/^\/accounts\/[^/]+\/workflows\/([^/]+)/, "Workflow"],
  // The Artifacts API (scripts/ensure-artifacts.ts): a namespace holds every repo and its history.
  [/^\/accounts\/[^/]+\/artifacts\/namespaces\/([^/]+)/, "Artifacts namespace"],
  // Before the database: a destroy plan names a role or branch with the database it lives in, so
  // admitting one never admits the database, and the same id elsewhere is not the plan's.
  [
    /^\/organizations\/[^/]+\/databases\/([^/]+\/branches\/[^/]+\/roles\/[^/]+)$/,
    "PlanetScale role",
  ],
  [/^\/organizations\/[^/]+\/databases\/([^/]+\/branches\/[^/]+)$/, "PlanetScale branch"],
  [/^\/organizations\/[^/]+\/databases\/([^/]+)/, "PlanetScale database"],
  // Deleting a token breaks whatever authenticates with it (the provider observation, for one).
  [/^\/accounts\/[^/]+\/tokens\/([^/]+)/, "API token"],
  [/^\/user\/tokens\/([^/]+)/, "API token"],
];
// Deletes that the API spells as a POST: they drop stored keys, vectors or messages.
const DATA_DELETE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)\/bulk\/delete$/, "KV namespace"],
  [
    /^\/accounts\/[^/]+\/vectorize\/(?:v2\/)?indexes\/([^/]+)\/delete[_-]by[_-]ids$/,
    "Vectorize index",
  ],
  [/^\/accounts\/[^/]+\/queues\/([^/]+)\/(?:messages\/)?purge$/, "Queue"],
];
// Alchemy's shared State store Worker (StateStore/State.ts STATE_STORE_SCRIPT_NAME) and every secret write.
const STATE_STORE =
  /^\/accounts\/[^/]+\/workers\/(?:scripts|workers|services)\/alchemy-state-store(?:\/|$)/;
const STATE_STORE_PREVIEW =
  /^\/accounts\/[^/]+\/workers\/scripts\/alchemy-state-store\/edge-preview$/;
// The only upload a deploy may send to the store script: one probe module binding one store secret
// (Cloudflare/StateStore/Token.ts names), nothing that could migrate, export or deploy.
const StoreCredentialRead = Schema.Struct({
  compatibility_date: Schema.optional(Schema.String),
  main_module: Schema.String,
  bindings: Schema.Tuple([
    Schema.Struct({
      type: Schema.Literal("secrets_store_secret"),
      name: Schema.String,
      secret_name: Schema.Literals(["AlchemyStateStoreToken", "AlchemyStateStoreEncryptionKey"]),
      store_id: Schema.String,
    }),
  ]),
});
const SECRET_WRITE = /^\/accounts\/[^/]+\/secrets_store\/stores\/[^/]+\/secrets(?:\/|$)/;
const APPLICATION = /^\/accounts\/[^/]+\/containers\/applications(?:\/([^/]+))?/;

const nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const List = Schema.optional(Schema.Array(Schema.Unknown));
const Step = Schema.Struct({
  new_classes: List,
  new_sqlite_classes: Schema.optional(Schema.Array(Schema.String)),
  deleted_classes: List,
  renamed_classes: List,
  transferred_classes: List,
});
const STEP_KEYS = new Set([
  "new_classes",
  "new_sqlite_classes",
  "deleted_classes",
  "renamed_classes",
  "transferred_classes",
]);
const MIGRATION_KEYS = new Set([...STEP_KEYS, "old_tag", "new_tag", "steps"]);
const Export = Schema.Struct({ state: Schema.optional(Schema.String) });
const Module = Schema.Struct({
  name: Schema.String,
  content_base64: Schema.optional(Schema.String),
});
const Metadata = Schema.Struct({
  main_module: Schema.optional(Schema.String),
  migrations: nullable(
    Schema.Struct({ ...Step.fields, steps: Schema.optional(Schema.Array(Step)) }),
  ),
  exports: nullable(Schema.Record(Schema.String, Export)),
  modules: Schema.optional(Schema.Array(Module)),
  bindings: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Created = Schema.Struct({ result: Schema.Struct({ id: Schema.String }) });
// The application read (lenient: production carries more keys). `health.instances` counts
// instances by state; `durable_objects` is the immutable namespace attachment.
const ApplicationRead = Schema.Struct({
  result: Schema.Struct({
    durable_objects: Schema.optional(Schema.Unknown),
    health: Schema.Struct({ instances: Schema.Record(Schema.String, Schema.Number) }),
  }),
});
// Every state but these means an instance is running or about to; `active` must be reported.
const SETTLED = new Set(["stopped", "failed"]);
const CHANGES = [
  "deleted_classes",
  "renamed_classes",
  "transferred_classes",
  "new_classes",
] as const;

/** The metadata JSON and the main module bytes, from a multipart or a JSON (beta) upload. */
const readUpload = async (request: Request) => {
  const copy = request.clone();
  if (!(copy.headers.get("content-type") ?? "").startsWith("multipart/form-data"))
    return { json: JSON.parse(await copy.text()) as unknown, part: () => null };
  const form = await copy.formData();
  const metadata = form.get("metadata") ?? form.get("settings");
  const raw = typeof metadata === "string" ? metadata : await metadata?.text();
  return { json: JSON.parse(raw ?? "") as unknown, part: (name: string) => form.get(name) };
};

const checkUpload = (config: WireGuardConfig, request: Request, at: At, script: string) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise(() => readUpload(request)).pipe(
      Effect.mapError((cause) => refuse(at, "unparsable", "metadata", "unparsable", cause)),
    );
    const meta = yield* Schema.decodeUnknownEffect(Metadata)(body.json).pipe(
      Effect.mapError((cause) => refuse(at, "malformed", "metadata", "malformed", cause)),
    );
    // A key this guard does not know could be a class change it cannot see: fail closed.
    const raw = (body.json as { migrations?: unknown } | null)?.migrations;
    for (const [step, value] of [
      ["migrations", raw] as const,
      ...(Array.isArray((raw as { steps?: unknown } | null)?.steps)
        ? ((raw as { steps: unknown[] }).steps.map((item, i) => [
            `migrations.steps[${i}]`,
            item,
          ]) as [string, unknown][])
        : []),
    ])
      if (value && typeof value === "object")
        for (const key of Object.keys(value))
          if (!(step === "migrations" ? MIGRATION_KEYS : STEP_KEYS).has(key))
            return yield* refuse(at, "malformed", `${step}.${key}`, "unknown migration key");
    const { migrations } = meta;
    const steps = migrations
      ? [
          ["migrations", migrations] as const,
          ...(migrations.steps ?? []).map((step, i) => [`migrations.steps[${i}]`, step] as const),
        ]
      : [];
    const fixed = config.fixedBindings?.[script];
    if (fixed) {
      for (const [step, value] of steps)
        for (const key of [...CHANGES, "new_sqlite_classes"] as const)
          if (value[key]?.length)
            return yield* refuse(at, "fixed", `${step}.${key}`, JSON.stringify(value[key]));
      // An upload without bindings drops them all; a settings write without them leaves them.
      const settingsOnly = new URL(request.url).pathname.endsWith("/settings");
      if (!settingsOnly || meta.bindings !== undefined) {
        // Names only: binding values and the scripts they point at stay out of the refusal.
        const differ = differingBindings(fixed, bindingShapes(meta.bindings, script));
        if (differ.length) return yield* refuse(at, "fixed", "bindings", differ.join(","));
      }
    }
    const allowed = config.sqliteClasses?.[script] ?? [];
    const anyNew = config.anyNewSqliteClass === true;
    const expected = config.mainModuleSha256?.[script];
    for (const [step, value] of steps) {
      for (const key of CHANGES)
        if (value[key]?.length)
          return yield* refuse(at, "change", `${step}.${key}`, JSON.stringify(value[key]));
      const added = value.new_sqlite_classes ?? [];
      const extra = added.filter((name) => !allowed.includes(name));
      if (extra.length && !anyNew)
        return yield* refuse(at, "sqlite", `${step}.new_sqlite_classes`, JSON.stringify(extra));
      if (added.length && !anyNew && expected === undefined)
        return yield* refuse(at, "pinned", "main_module sha256", "not configured");
    }
    for (const [name, entry] of Object.entries(meta.exports ?? {}))
      if (entry.state !== undefined && entry.state !== "created")
        return yield* refuse(at, "export", `exports.${name}.state`, entry.state);
    if (expected === undefined) return;
    const main = meta.main_module ?? "";
    const part = body.part(main);
    const inline = meta.modules?.find((module) => module.name === main)?.content_base64;
    const bytes =
      part instanceof Blob
        ? new Uint8Array(yield* Effect.promise(() => part.arrayBuffer()))
        : typeof part === "string"
          ? new TextEncoder().encode(part)
          : inline !== undefined
            ? Buffer.from(inline, "base64")
            : undefined;
    if (!bytes) return yield* refuse(at, "main", "main_module", main);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected)
      return yield* refuse(at, "hash", "main_module sha256", `${actual} (expected ${expected})`);
  });

const checkStoreCredentialRead = (request: Request, at: At) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise(async () => {
      const form = await request.clone().formData();
      const metadata = form.get("metadata");
      const raw = typeof metadata === "string" ? metadata : ((await metadata?.text()) ?? "");
      return { parts: [...form.keys()], json: JSON.parse(raw) as unknown };
    }).pipe(
      Effect.mapError((cause) => refuse(at, "store", "edge-preview body", "unparsable", cause)),
    );
    const meta = yield* Schema.decodeUnknownEffect(StoreCredentialRead, {
      onExcessProperty: "error",
    })(body.json).pipe(
      Effect.mapError((cause) =>
        refuse(
          at,
          "store",
          "edge-preview metadata",
          JSON.stringify(body.json).slice(0, 300),
          cause,
        ),
      ),
    );
    // Besides the metadata, the preview session's own config part and exactly the probe module.
    const modules = body.parts.filter(
      (name) => name !== "metadata" && name !== "wrangler-session-config",
    );
    if (modules.length !== 1 || modules[0] !== meta.main_module)
      return yield* refuse(at, "store", "edge-preview parts", JSON.stringify(body.parts));
  });

/**
 * Alchemy deletes and recreates an application that exists without its Durable Object attachment
 * (ContainerProvider: precreate, then the real reconcile), which is what a rerun after a killed
 * apply meets. The delete is admitted only when a fresh read, sent around the guard with the same
 * credentials, shows no attachment and nothing running; any other answer or a failed read refuses.
 */
const checkUnattached = (inner: typeof globalThis.fetch, request: Request, at: At) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/(\/containers\/applications\/[^/]+).*$/u, "$1");
    url.search = "";
    const authorization = request.headers.get("authorization");
    const read = yield* Effect.tryPromise(async () => {
      const response = await inner(url, {
        method: "GET",
        headers: authorization ? { authorization } : {},
      });
      if (!response.ok) throw new Error(`application read answered ${response.status}`);
      return (await response.json()) as unknown;
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ApplicationRead)),
      Effect.mapError((cause) => refuse(at, "application", "application read", "failed", cause)),
    );
    const { durable_objects: attached, health } = read.result;
    if (attached !== undefined && attached !== null)
      return yield* refuse(at, "application", "durable_objects", "attached");
    const running = Object.entries(health.instances).filter(
      ([state, count]) => !SETTLED.has(state) && count !== 0,
    );
    if (health.instances.active === undefined || running.length)
      return yield* refuse(
        at,
        "application",
        "health.instances",
        running.length ? JSON.stringify(Object.fromEntries(running)) : "active not reported",
      );
  });

const authHeaders = (request: Request) => {
  const headers = new Headers();
  for (const name of ["authorization", "x-auth-email", "x-auth-key"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
};

/**
 * A Worker or Workflow name the stage's State does not record: Cloudflare places it. Absent means
 * this run creates it; present, it must carry this stage's Alchemy tags (a Worker) or run on a
 * Worker the stage owns (a Workflow). Anything unreadable is refused.
 */
const proveStageName = (
  scope: StageScope,
  isOwned: (value: string) => boolean,
  inner: typeof globalThis.fetch,
  request: Request,
  url: URL,
  verdict: Extract<StageVerdict, { kind: "prove" }>,
) =>
  Effect.gen(function* () {
    const at = url.pathname.search(/\/accounts\//u);
    const account = /^\/accounts\/([^/]+)/u.exec(url.pathname.slice(at))?.[1] ?? "";
    const base = `${url.origin}${url.pathname.slice(0, at)}/accounts/${account}`;
    const name = encodeURIComponent(verdict.name);
    const read =
      verdict.family === "Worker"
        ? `${base}/workers/scripts/${name}/settings`
        : `${base}/workflows/${name}`;
    const response = yield* Effect.promise(() =>
      inner(read, { headers: authHeaders(request) }).catch(() => undefined),
    );
    if (response?.status === 404) return;
    const body = response?.ok
      ? ((yield* Effect.promise(() => response.json().catch(() => null))) as {
          result?: { tags?: unknown; script_name?: unknown };
        } | null)
      : null;
    const tags = Array.isArray(body?.result?.tags) ? body.result.tags : [];
    const owner = body?.result?.script_name;
    const ours =
      verdict.family === "Worker"
        ? tags.includes(`alchemy:stack:${scope.stack}`) &&
          tags.includes(`alchemy:stage:${scope.stage}`)
        : typeof owner === "string" && isOwned(owner);
    if (!ours)
      return yield* refuse(
        {
          resource: `${verdict.family} ${verdict.name}`,
          method: request.method,
          path: template(apiPath(url.pathname)),
        },
        "stage",
        "owner",
        response ? `HTTP ${response.status}` : "unreadable",
      );
  });

/** The stage rule, before every other check: what the write targets must be the stage's own. */
const stageGate = (
  config: WireGuardConfig,
  ownedHere: Set<string>,
  inner: typeof globalThis.fetch,
  request: Request,
  url: URL,
  path: string,
) =>
  Effect.gen(function* () {
    const scope = config.stage;
    const method = request.method.toUpperCase();
    if (!scope || method === "GET" || method === "HEAD") return undefined;
    // Alchemy's read of the store token and the self-test's own probe have their own checks.
    if (STATE_STORE_PREVIEW.test(path) || path.endsWith(`/workers/scripts/${PROBE_SCRIPT}`))
      return undefined;
    const body = (request.headers.get("content-type") ?? "").includes("json")
      ? yield* Effect.promise(() =>
          request
            .clone()
            .json()
            .catch(() => undefined),
        )
      : undefined;
    const isOwned = (value: string) => scope.owned.includes(value) || ownedHere.has(value);
    const verdict = stageWriteVerdict(scope, isOwned, method, url, body);
    if (verdict.kind === "refuse")
      return yield* refuse(
        { resource: verdict.resource, method, path: template(path) },
        "stage",
        verdict.field,
        url.pathname,
      );
    if (verdict.kind === "prove") {
      yield* proveStageName(scope, isOwned, inner, request, url, verdict);
      ownedHere.add(verdict.name);
      return undefined;
    }
    return verdict.creates ? { body } : undefined;
  });

const check = (
  config: WireGuardConfig,
  created: ReadonlySet<string>,
  held: ReadonlySet<string>,
  inner: typeof globalThis.fetch,
  request: Request,
  path: string,
) =>
  Effect.gen(function* () {
    const method = request.method.toUpperCase();
    const name = (pattern: RegExp) => {
      const found = pattern.exec(path)?.[1];
      return found === undefined ? undefined : decodeURIComponent(found);
    };
    const at = (kind: string, id: string) => ({
      resource: `${kind} ${id}`,
      method,
      path: template(path),
    });
    // Alchemy reads the store's token through an ephemeral edge preview of the store script
    // (StateStore/State.ts readSecretViaEdge, Cloudflare/EdgeSession.ts): admitted only in that exact shape.
    if (STATE_STORE_PREVIEW.test(path) && (method === "PUT" || method === "POST"))
      return yield* checkStoreCredentialRead(request, at("State store", "edge-preview"));
    // Alchemy's read of the store token above is the one write-shaped request a read may send.
    if (
      config.readOnly &&
      method !== "GET" &&
      method !== "HEAD" &&
      !path.endsWith(`/workers/scripts/${PROBE_SCRIPT}`)
    )
      return yield* refuse(at("request", "{id}"), "readonly", "method", method);
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      (STATE_STORE.test(path) || SECRET_WRITE.test(path))
    )
      return yield* refuse(
        at(STATE_STORE.test(path) ? "State store" : "Secrets Store secret", "{id}"),
        "store",
        "method",
        method,
      );
    const application = name(APPLICATION);
    if (
      application !== undefined &&
      method !== "GET" &&
      method !== "HEAD" &&
      (config.rootApplications?.includes(application) || held.has(application))
    )
      return yield* refuse(at("container application", application), "root", "method", method);
    const script = name(UPLOAD);
    if (script !== undefined && ["PUT", "POST", "PATCH"].includes(method))
      return yield* checkUpload(config, request, at("Worker", script), script);
    if (method === "POST")
      for (const [pattern, kind] of DATA_DELETE) {
        const id = name(pattern);
        if (id !== undefined) return yield* refuse(at(kind, id), "delete", "method", "POST");
      }
    if (method !== "DELETE") return;
    for (const [pattern, kind] of [[APPLICATION, "container application"], ...PROTECTED] as const) {
      const id = name(pattern);
      if (
        id !== undefined &&
        config.deletable?.some((entry) => entry.kind === kind && entry.id === id)
      )
        return;
    }
    if (application !== undefined && !created.has(application))
      return yield* checkUnattached(inner, request, at("container application", application));
    for (const [pattern, kind] of PROTECTED) {
      const id = name(pattern);
      if (id !== undefined) return yield* refuse(at(kind, id), "delete", "method", "DELETE");
    }
  });

/** Wraps globalThis.fetch for the life of the scope and returns the guarded fetch as a layer. */
export const install = (config: WireGuardConfig = {}) =>
  Effect.gen(function* () {
    const inner = globalThis.fetch;
    const journal: Array<JournalEntry> = [];
    const created = new Set<string>();
    // Ids an application read named as the root's, whatever id State recorded.
    const held = new Set<string>();
    // What this run created on a disposable stage: its own from here on.
    const ownedHere = new Set<string>();
    const refused = Deferred.makeUnsafe<never, WireRefused>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = apiPath(url.pathname);
      journal.push({ method: request.method, host: url.host, path: template(path) });
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const creates = yield* stageGate(config, ownedHere, inner, request, url, path);
          yield* check(config, created, held, inner, request, path);
          return creates;
        }),
      );
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        // The self-test's own probe is refused on purpose and must not end the run.
        if (error instanceof WireRefused && !path.endsWith(`/workers/scripts/${PROBE_SCRIPT}`))
          Deferred.doneUnsafe(refused, Effect.fail(error));
        throw error;
      }
      const response = await inner(request);
      if (exit.value && response.ok)
        for (const name of createdIdentities(
          await response
            .clone()
            .json()
            .catch(() => null),
          exit.value.body,
        ))
          ownedHere.add(name);
      // Only a create of an application (a POST to the collection itself) feeds the created set.
      if (request.method === "POST" && response.ok && path.endsWith("/containers/applications")) {
        const decoded = Schema.decodeUnknownExit(Created)(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        if (Exit.isSuccess(decoded)) created.add(decoded.value.result.id);
      }
      if (
        request.method === "GET" &&
        response.ok &&
        config.rootApplicationNames?.length &&
        APPLICATION.test(path)
      ) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { result?: unknown } | null;
        for (const item of [body?.result].flat())
          if (
            item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string" &&
            config.rootApplicationNames.includes(String((item as { name?: unknown }).name))
          )
            held.add((item as { id: string }).id);
      }
      return response;
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => void (globalThis.fetch = fetch)),
      () => Effect.sync(() => void (globalThis.fetch = inner)),
    );
    return {
      fetch,
      journal: journal as ReadonlyArray<JournalEntry>,
      /** Fails with the first refusal; race the deploy against it so retries cannot hide one. */
      refused: Deferred.await(refused),
      layer: Layer.succeed(FetchHttpClient.Fetch, fetch),
    };
  });

const PROBE_SCRIPT = "__wire_guard_probe";

const probe = (base: string) => {
  const form = new FormData();
  const metadata = { main_module: "probe.js", migrations: { deleted_classes: ["PoolContainer"] } };
  form.append("metadata", JSON.stringify(metadata));
  form.append("probe.js", new Blob(["export default {};"]), "probe.js");
  const url = `${base}/accounts/${"0".repeat(32)}/workers/scripts/${PROBE_SCRIPT}`;
  return HttpClient.execute(
    HttpClientRequest.put(url).pipe(HttpClientRequest.bodyFormData(form)),
  ).pipe(Effect.provide(FetchHttpClient.layer));
};

/**
 * Proves in this process that a class-deleting upload through Effect's FetchHttpClient is refused
 * locally, both with the caller's context and from a fresh root runtime (the cached default).
 */
export const selfTest = (base = "https://api.cloudflare.com/client/v4") =>
  Effect.gen(function* () {
    for (const route of ["context", "default"] as const) {
      const exit =
        route === "context"
          ? yield* Effect.exit(probe(base))
          : yield* Effect.promise(() => Effect.runPromiseExit(probe(base)));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      const reason = (error as { reason?: { cause?: unknown } } | undefined)?.reason?.cause;
      if (!(reason instanceof WireRefused && reason.field === "migrations.deleted_classes"))
        return yield* new WireGuardSelfTestFailed({
          route,
          why: error ? `No wire guard refusal: ${String(error)}` : "The probe got a response.",
          fix: "Install the guard before anything sends, and provide guard.layer at the root.",
          cause: error,
        });
    }
  });
