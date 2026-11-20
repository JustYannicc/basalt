import { Effect, Schema } from "effect";
import { refuse, type FleetLaneRefused } from "./errors.ts";

// Reads only. Decoding is lenient: Cloudflare adds fields (annotations, runtime, health) without notice,
// and only the fields named here decide anything.

export interface CloudflareAccess {
  accountId: string;
  apiToken: string;
  fetch: typeof globalThis.fetch;
  /** Tests point this at a local server; production always uses the public API. */
  origin?: string;
}

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
  result: Schema.Unknown,
});

const read = (access: CloudflareAccess, path: string, label: string) =>
  Effect.gen(function* () {
    const url = `${access.origin ?? "https://api.cloudflare.com"}/client/v4/accounts/${encodeURIComponent(access.accountId)}${path}`;
    const response = yield* Effect.tryPromise({
      try: () =>
        access.fetch(url, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${access.apiToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        }),
      catch: () =>
        refuse(
          `${label}-unreachable`,
          `GET ${label} returned no HTTP response.`,
          "Rerun; if it repeats, check the Cloudflare API status.",
        ),
    });
    const text = yield* Effect.promise(() => response.text());
    if (response.status !== 200)
      return yield* Effect.fail(
        refuse(
          `${label}-http-${response.status}`,
          `GET ${label} answered HTTP ${response.status}, expected 200.`,
          "Check that CLOUDFLARE_API_TOKEN can read Workers scripts and Containers on this account.",
        ),
      );
    const envelope = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Envelope)(JSON.parse(text)),
      catch: () =>
        refuse(
          `${label}-envelope`,
          `GET ${label} did not return a Cloudflare envelope {success, result}.`,
          "Capture the response shape and update scripts/pool-fleet/cloudflare.ts.",
        ),
    });
    if (!envelope.success || envelope.errors?.length)
      return yield* Effect.fail(
        refuse(
          `${label}-unsuccessful`,
          `GET ${label} answered success=${envelope.success} with ${envelope.errors?.length ?? 0} errors.`,
          "Check the token's permissions and the account id.",
        ),
      );
    return envelope.result;
  });

const field = <A>(schema: Schema.Codec<A>, value: unknown, reason: string, why: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () =>
      refuse(reason, why, "Capture the live shape and update scripts/pool-fleet/cloudflare.ts."),
  });

const ScriptList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
);

/** The production PoolWorker is the one script Alchemy tagged with this stack, stage and id. */
export const poolWorkerName = (access: CloudflareAccess, stack = "basalt", stage = "production") =>
  Effect.gen(function* () {
    const scripts = yield* field(
      ScriptList,
      yield* read(access, "/workers/scripts", "workers-scripts"),
      "workers-scripts-shape",
      "GET workers/scripts result is not an array of {id, tags}.",
    );
    const wanted = [`alchemy:stack:${stack}`, `alchemy:stage:${stage}`, "alchemy:id:PoolWorker"];
    const matches = scripts.filter((script) => wanted.every((tag) => script.tags?.includes(tag)));
    if (matches.length !== 1)
      return yield* Effect.fail(
        refuse(
          "pool-worker-not-unique",
          `${matches.length} scripts carry the tags ${wanted.join(", ")}; exactly 1 is required.`,
          "Deploy the production stack first, or remove the stray script that copies its tags.",
        ),
      );
    return matches[0]!.id;
  });

const Settings = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  ),
});

/** Plain-text bindings of the deployed PoolWorker; secret bindings never carry a value here. */
export const workerPlainBindings = (access: CloudflareAccess, worker: string) =>
  Effect.gen(function* () {
    const settings = yield* field(
      Settings,
      yield* read(
        access,
        `/workers/scripts/${encodeURIComponent(worker)}/settings`,
        "worker-settings",
      ),
      "worker-settings-shape",
      "GET workers/scripts/{PoolWorker}/settings result.bindings is not an array of {name, type}.",
    );
    return Object.fromEntries(
      settings.bindings
        .filter((binding) => binding.type === "plain_text" && binding.text !== undefined)
        .map((binding) => [binding.name, binding.text!]),
    ) as Record<string, string>;
  });

export const requireBinding = (
  bindings: Record<string, string>,
  name: string,
): Effect.Effect<string, FleetLaneRefused> =>
  bindings[name]
    ? Effect.succeed(bindings[name])
    : Effect.fail(
        refuse(
          "worker-binding-missing",
          `PoolWorker has no plain_text binding ${name}.`,
          "Deploy PoolWorker with both fleet colours declared (POOL_FLEET_BUILD=true) before configuring.",
        ),
      );

/** The raw RESOLVED application read-back; the controller's own decoder digests it. */
export const containerApplication = (access: CloudflareAccess, applicationId: string) =>
  read(
    access,
    `/containers/applications/${encodeURIComponent(applicationId)}`,
    "container-application",
  );
