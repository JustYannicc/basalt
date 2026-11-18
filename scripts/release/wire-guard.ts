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
  store: [
    "A deploy must never redeploy the shared State store or rewrite a Secrets Store secret; that rotates the store token every stack reads.",
    "Upgrade or bootstrap the store by hand under its own approval.",
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
  pathname.slice(Math.max(0, pathname.search(/\/(accounts|organizations)\//)));

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
  [/^\/organizations\/[^/]+\/databases\/([^/]+)/, "PlanetScale database"],
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
    const { migrations } = meta;
    const steps = migrations
      ? [
          ["migrations", migrations] as const,
          ...(migrations.steps ?? []).map((step, i) => [`migrations.steps[${i}]`, step] as const),
        ]
      : [];
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

const check = (
  config: WireGuardConfig,
  created: ReadonlySet<string>,
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
    const script = name(UPLOAD);
    if (script !== undefined && ["PUT", "POST", "PATCH"].includes(method))
      return yield* checkUpload(config, request, at("Worker", script), script);
    if (method === "POST")
      for (const [pattern, kind] of DATA_DELETE) {
        const id = name(pattern);
        if (id !== undefined) return yield* refuse(at(kind, id), "delete", "method", "POST");
      }
    if (method !== "DELETE") return;
    const application = name(APPLICATION);
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
    const refused = Deferred.makeUnsafe<never, WireRefused>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = apiPath(url.pathname);
      journal.push({ method: request.method, host: url.host, path: template(path) });
      const exit = await Effect.runPromiseExit(check(config, created, inner, request, path));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        // The self-test's own probe is refused on purpose and must not end the run.
        if (error instanceof WireRefused && !path.endsWith(`/workers/scripts/${PROBE_SCRIPT}`))
          Deferred.doneUnsafe(refused, Effect.fail(error));
        throw error;
      }
      const response = await inner(request);
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
