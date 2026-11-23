/**
 * Production's release: Alchemy's own plan and apply, one smoke turn, and Cloudflare's own rollback
 * of the Workers the apply updated when that turn fails. These are the calls `alchemy deploy` makes
 * (Stack.plan, then Stack.apply) with `updateStateStore` always false: the CLI's `--yes` also sets
 * it, and a short State store outage could then redeploy the shared store with a new token.
 *
 *   bun scripts/production.ts plan   [--fleet-classes]   prints each row's name, type and action
 *   bun scripts/production.ts deploy [--fleet-classes]   plans, applies, smokes; re-points on failure
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type * as Fx from "effect/Effect";

const fleetClasses = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

/**
 * Whether the fleet's classes are declared. The switch only turns them on: once PoolWorker hosts
 * them, leaving them out would delete every object of both classes, so they stay declared.
 */
export const classesDeclared = (requested: boolean, hosted: readonly string[]) =>
  requested || fleetClasses.some((name) => hosted.includes(name));

export const fleetEnvironment = (declared: boolean): Record<string, string | undefined> =>
  declared
    ? { POOL_FLEET_BUILD: "true", POOL_FLEET_CLASSES: undefined }
    : { POOL_FLEET_BUILD: undefined, POOL_FLEET_CLASSES: "absent" };

type Wire = { type?: unknown; className?: unknown; scriptName?: unknown };
type Binding = { sid?: string; action?: string; data?: unknown };
type State = {
  status?: string;
  old?: State;
  attr?: { workerName?: unknown; durableObjectNamespaces?: Record<string, unknown> };
  bindings?: readonly Binding[];
};
type PlanNode = {
  action?: string;
  resource?: { Type?: string };
  bindings?: Binding[];
  state?: State;
};
type RootRow = { fqn: string; action: string; changedProps: readonly string[] };
type Plan = {
  resources: Record<string, PlanNode | undefined>;
  deletions?: Record<string, PlanNode | undefined>;
};
type Snapshot = {
  summary: Record<string, number>;
  resources: {
    fqn: string;
    resourceType: string;
    action: string;
    bindings?: { action: string }[];
  }[];
  actions?: { fqn: string; actionType: string; action: string }[];
  native: Plan;
};

/** Our own words, naming only resources and classes: the one error printed whole. */
class Refused extends Error {}

const workers = (plan: Plan) =>
  Object.entries(plan.resources).flatMap(([fqn, node]) =>
    node?.resource?.Type === "Cloudflare.Worker" ? [[fqn, node] as const] : [],
  );

/** The Workers this apply uploads a new version of: the ones a failed smoke puts back. */
export const workersToRepoint = (plan: Plan) =>
  workers(plan)
    .filter(
      ([, node]) => node.action === "update" || node.bindings?.some((b) => b.action !== "noop"),
    )
    .map(([fqn]) => fqn)
    .sort();

/** The classes a binding hosts on its own Worker: Durable Object bindings to no other script. */
const localClasses = ({ data }: Binding) => {
  const wires = (data as { bindings?: unknown } | undefined)?.bindings;
  return (Array.isArray(wires) ? (wires as Wire[]) : [])
    .filter((wire) => wire.type === "durable_object_namespace" && wire.scriptName === undefined)
    .map((wire) => String(wire.className));
};

/** A Worker row's own classes: the generation it finished and any an interrupted apply started. */
const recordedClasses = (state?: State) =>
  [state, state?.old].flatMap((row) =>
    (row?.bindings ?? []).flatMap((binding) =>
      localClasses(binding).map((name) => ({ sid: binding.sid, name })),
    ),
  );

/**
 * The Durable Object classes a plan creates and drops. A drop is a Worker's own recorded class whose
 * binding the plan deletes or no longer has, or any class of a Worker it deletes or replaces:
 * Alchemy sends it as `deleted_classes`, which deletes every object of the class, so it is never
 * applied. A created class cannot be rolled back.
 */
export function classChanges(plan: Plan) {
  const dropped = new Set<string>();
  const created = new Set<string>();
  for (const [fqn, node] of workers(plan)) {
    const recorded = recordedClasses(node.state);
    const planned = new Map(node.bindings?.map((binding) => [binding.sid, binding.action]));
    for (const { sid, name } of recorded)
      if (node.action === "replace" || [undefined, "delete"].includes(planned.get(sid)))
        dropped.add(`${fqn}: ${name}`);
    const before = new Set(recorded.map(({ name }) => name));
    for (const binding of node.bindings ?? [])
      if (binding.action !== "delete")
        for (const name of localClasses(binding))
          if (!before.has(name)) created.add(`${fqn}: ${name}`);
  }
  for (const [fqn, node] of workers({ resources: plan.deletions ?? {} }))
    for (const { name } of recordedClasses(node.state)) dropped.add(`${fqn}: ${name}`);
  return { dropped: [...dropped].sort(), created: [...created].sort() };
}

/** The resource types that hold data: a release never deletes or replaces one. */
const dataTypes = [
  "Planetscale.PostgresDatabase",
  "Planetscale.PostgresBranch",
  "Cloudflare.R2.Bucket",
  "Cloudflare.D1Database",
  "Cloudflare.SecretsStore",
  "Cloudflare.Hyperdrive",
];

/** The data resources the plan deletes or replaces, by name, type and action. */
export const removals = (snapshot: Pick<Snapshot, "resources"> & { native: Plan }) =>
  [
    ...snapshot.resources,
    ...Object.entries(snapshot.native.deletions ?? {}).map(([fqn, node]) => ({
      fqn,
      resourceType: node?.resource?.Type ?? "unknown",
      action: "delete",
    })),
  ]
    .filter(({ action }) => action === "delete" || action === "replace")
    .filter(({ resourceType }) => dataTypes.includes(resourceType))
    .map(({ fqn, resourceType, action }) => `${fqn} (${resourceType}) ${action}`)
    .filter((line, index, all) => all.indexOf(line) === index);

/** A deployment a rollback made, ours or the old entry's: State still records the upload before it. */
const rollbackMessage = /^(?:production smoke failed|release rollback )/u;
type Deployment = {
  annotations?: Record<string, unknown>;
  versions?: { version_id?: string; percentage?: number }[];
};

/**
 * Where a Worker the plan leaves alone re-points forward when a rollback made its serving
 * deployment: the version the newest deployment that is no rollback served. A noop row means the
 * wanted upload is the one State recorded, and that is the version the last release deployed.
 * Undefined when no rollback serves; null when that version cannot be told (a split, or none listed).
 */
export function forwardVersion(deployments: readonly Deployment[]) {
  const rolledBack = (deployment?: Deployment) =>
    rollbackMessage.test(String(deployment?.annotations?.["workers/message"] ?? ""));
  if (!rolledBack(deployments[0])) return undefined;
  const [only, ...rest] = deployments.find((deployment) => !rolledBack(deployment))?.versions ?? [];
  return only?.version_id && only.percentage === 100 && !rest.length ? only.version_id : null;
}

/**
 * The root's row may only be the attachment-only update a pool Worker update brings (carry 0696):
 * no prop changes, and the provider reads the root's application and sends nothing. Anything else
 * would roll the root, which no release does.
 */
export const rootChange = (row?: { action: string; changedProps: readonly string[] }) =>
  !row
    ? "untouched"
    : ["update", "noop"].includes(row.action) && !row.changedProps.length
      ? "attachment"
      : "refused";

/** The stack's database commands this plan runs: the hosted migrations and the pool database. */
export const databaseSteps = (rows: readonly { fqn: string; action: string }[]) =>
  rows
    .filter(({ fqn, action }) => ["Migrations", "PoolDatabase"].includes(fqn) && action !== "noop")
    .map(({ fqn }) => fqn);

/** One streamed turn through the public pool. Says why it failed by error class and status only. */
export async function smoke(send: () => Promise<unknown>) {
  try {
    await send();
    return { passed: true } as const;
  } catch (error) {
    const status = (error as { status?: unknown } | undefined)?.status;
    const name = error instanceof Error ? error.name : "failure";
    return {
      passed: false,
      why: typeof status === "number" ? `${name}, HTTP ${status}` : name,
    } as const;
  }
}

// A rollback Cloudflare refuses over a changed secret is forced only for these: the telemetry
// secret carries the upstream pin, and AppCompiler's apps version the served framework version
// (until #1726 binds it plainly). Forced, the earlier version gets back the value it ran with.
const forceSecrets = new Set(["EXECUTOR_TELEMETRY", "EXECUTOR_APPS_VERSION"]);

const say = async (line: string) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "fleet-classes": { type: "boolean" } },
  });
  const mode = positionals[0];
  if (mode !== "plan" && mode !== "deploy") throw new Refused("Usage: production.ts plan|deploy");
  const { actionLine, deployApproval, planDifference, planDigest, rowLine } =
    await import("./release/approved-plan.ts");
  // A deploy applies only the plan someone read: without its digest it stops before anything runs.
  const approval = deployApproval(mode, process.env.BASALT_APPROVED_PLAN);
  if (approval.refusal) throw new Refused(approval.refusal);
  const candidate = process.env.BASALT_RELEASE_CANDIDATE ?? "";
  const model = process.env.POOL_ACCEPTANCE_MODEL ?? "";
  if (mode === "deploy" && !model)
    throw new Refused("POOL_ACCEPTANCE_MODEL names the smoke's model");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { deployEnvironment } = await import("./environment.ts");
  const { assignEnvironment } = await import("./release/process-env.ts");
  assignEnvironment(process.env, deployEnvironment());
  // Every State store bootstrap branch dies instead of prompting under CI.
  assignEnvironment(process.env, {
    ALCHEMY_STAGE: "production",
    BASALT_RELEASE_ATTEMPT: randomUUID(),
    CI: "true",
  });
  // The root is declared by its pinned image (POOL_ROOT_PIN plus the account), never built.
  (await import("./release/root-pin.ts")).setRootPin(process.env);
  // A missing or malformed acceptance device stops here, before anything changes.
  const { acceptanceCredential } = await import("./release/acceptance-device.ts");
  const credential = mode === "deploy" ? acceptanceCredential(process.env) : undefined;
  // Alchemy captures the working directory on its first load and resolves the stack's commands
  // from it; they are declared relative to the cloud app.
  process.chdir(resolve(root, ".upstream/apps/hosted/cloud"));
  const { initialCwd } = await import("alchemy/Util/Node");
  if (initialCwd !== process.cwd()) throw new Refused("Alchemy loaded before the cloud app");
  const { Cause, Effect, Logger, Redacted } = await import("effect");
  const { FetchHttpClient, HttpClient, HttpClientRequest } = await import("effect/http");
  const Alchemist = await import("alchemy/Alchemist");
  const Session = await import("alchemy/Alchemist/Session");
  const { storeCannotBootstrap } = await import("./release/state-store-guard.ts");
  const { rollbackTo, servingVersion } = await import("./release/worker-version.ts");
  const { takeBackup } = await import("./release/database-safety.ts");
  const { progressTracker } = await import("./release/public-report.ts");
  const { failureLine } = await import("./release/failure-line.ts");
  const { changedRows } = await import("./release/plan-summary.ts");
  // Alchemy's own progress events: the resource that reported a failure, by name and type.
  const tracker = progressTracker();
  const progress = (event: unknown) => Effect.sync(() => tracker.track(event));
  const target = { entrypoint: resolve(root, "alchemy.run.ts"), stage: "production" };
  // Each run is its own Alchemy session, which reads the environment when it first loads the
  // stack. Alchemy's own log lines name scripts and hosts; the public log gets only ours.
  const run = <A>(effect: Fx.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      Effect.scoped(Effect.andThen(storeCannotBootstrap, effect)).pipe(
        Effect.provideService(Alchemist.Progress, progress as never),
        Effect.provide(Alchemist.layer()),
        Effect.provide(Logger.layer([])),
        Effect.provide(FetchHttpClient.layer),
      ) as Fx.Effect<A, unknown, never>,
    );
  const at = (script: string) => ({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
    script,
  });
  const print = (line: string) => Effect.promise(() => say(line));
  // A script's deployments, newest first; a rollback writes its message on its own.
  const deploymentsOf = (target: ReturnType<typeof at>) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const response = yield* client.execute(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.script)}/deployments`,
        ).pipe(HttpClientRequest.bearerToken(Redacted.value(target.token))),
      );
      const body = (yield* response.json) as { result?: { deployments?: Deployment[] } };
      return body.result?.deployments ?? [];
    });
  const refuse = (line: string) =>
    Effect.andThen(print(`::error::${line}`), Effect.fail(new Refused(line)));

  // First session: the classes PoolWorker hosts, read before the stack reads the fleet's setting.
  const hosted = await run(
    Effect.gen(function* () {
      type Key = { stack: string; stage: string; fqn: string };
      const store = (yield* Alchemist.State.store({
        backend: "configured",
        ...target,
      } as never)) as { get: (key: Key) => Fx.Effect<State | undefined, unknown, never> };
      const { stackName } = yield* Session.importStack(target.entrypoint) as unknown as Fx.Effect<
        { stackName: string },
        unknown,
        never
      >;
      const pool = yield* store.get({ stack: stackName, stage: "production", fqn: "PoolWorker" });
      return [pool, pool?.old].flatMap((row) =>
        Object.keys(row?.attr?.durableObjectNamespaces ?? {}),
      );
    }),
  );
  const declared = classesDeclared(values["fleet-classes"] === true, hosted);
  assignEnvironment(process.env, fleetEnvironment(declared));

  // Second session plans and applies: the snapshot holds this session's providers.
  const { serving, applied, creating } = await run(
    Effect.gen(function* () {
      const snapshot = (yield* Alchemist.Stack.plan({
        target,
        operation: "deploy",
        updateStateStore: false,
      } as never)) as unknown as Snapshot;
      const { dropped, created } = classChanges(snapshot.native);
      yield* print(
        `Plan of ${candidate}, fleet classes ${declared ? "declared" : "absent"}: ${JSON.stringify(snapshot.summary)}`,
      );
      // Stack actions run during the apply too, so they are rows the plan shows and the digest covers.
      for (const line of [
        ...snapshot.resources.map(rowLine),
        ...(snapshot.actions ?? []).map(actionLine),
      ])
        if (line) yield* print(`- ${line}`);
      yield* print(
        `Creates Durable Object classes (cannot be rolled back): ${created.join(", ") || "none"}`,
      );
      if (dropped.length)
        return yield* refuse(
          `The plan drops Durable Object classes (${dropped.join("; ")}); nothing applied`,
        );
      const removed = removals(snapshot);
      if (removed.length)
        return yield* refuse(`The plan deletes or replaces ${removed.join("; ")}; nothing applied`);
      const root = (changedRows(snapshot as never) as RootRow[]).find(
        (r) => r.fqn === "PoolContainer",
      );
      if (rootChange(root) === "refused")
        return yield* refuse(
          `The plan changes the root container (${root!.action}${root!.changedProps.length ? `: ${root!.changedProps.join(", ")}` : ""}); no release rolls the root`,
        );
      if (rootChange(root) === "attachment")
        yield* print(
          "PoolContainer: its attachment only, no prop changes; the provider reads the root and sends nothing",
        );
      // One deployments read per Worker the plan leaves alone: one a rollback left behind goes
      // forward to the upload State records, or the run stops when that version cannot be told.
      const forward: { fqn: string; script: string; version: string }[] = [];
      const unclear: string[] = [];
      const uploads = new Set(workersToRepoint(snapshot.native));
      for (const [fqn, node] of workers(snapshot.native)) {
        const script = String(node.state?.attr?.workerName ?? "");
        if (uploads.has(fqn) || !script) continue;
        const version = forwardVersion(yield* deploymentsOf(at(script)));
        if (version === null) unclear.push(fqn);
        else if (version) forward.push({ fqn, script, version });
      }
      if (unclear.length)
        return yield* refuse(
          `A rollback serves ${unclear.join(", ")} and the version the last release deployed cannot be told; nothing applied`,
        );
      yield* print(`Re-points forward: ${forward.map(({ fqn }) => fqn).join(", ") || "none"}`);
      // The stack read the setting this run set, or this run stops before it applies anything.
      const fleet = created.filter((name) => fleetClasses.some((cls) => name.endsWith(`: ${cls}`)));
      if (
        fleet.length !== (declared ? fleetClasses.filter((cls) => !hosted.includes(cls)).length : 0)
      )
        return yield* refuse(
          `The plan's fleet classes (${fleet.join(", ") || "none"}) do not match the switch`,
        );
      const reading = {
        candidate,
        declared,
        rows: snapshot.resources,
        actions: snapshot.actions ?? [],
        created,
        forward: forward.map(({ fqn }) => fqn),
      };
      yield* print(`Plan digest: ${planDigest(reading)}`);
      const serving: { fqn: string; script: string; version: string }[] = [];
      if (mode === "plan") return { serving, applied: false, creating: created.length > 0 };
      // Nothing has been written yet: the backup, the re-points and the apply all come after this.
      const difference = planDifference(approval.approved!, reading);
      if (difference) return yield* refuse(difference);
      for (const fqn of [...uploads, ...forward.map((worker) => worker.fqn)]) {
        const script = String(snapshot.native.resources[fqn]!.state?.attr?.workerName ?? "");
        serving.push({ fqn, script, version: yield* servingVersion(at(script)) });
      }
      yield* print(
        `Serving before the apply: ${serving.map((w) => `${w.fqn} ${w.version}`).join(", ") || "none"}`,
      );
      // A re-point does not undo a database step: its recovery point is a backup taken just before.
      const steps = databaseSteps(snapshot.resources);
      if (steps.length) {
        const name = `basalt-release-v3-${candidate.slice(0, 12)}-${process.env.GITHUB_RUN_ID ?? "local"}`;
        const backup = yield* Effect.exit(
          takeBackup({
            organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
            tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
            token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
            database: "basalt",
            branch: "main",
            name,
          }),
        );
        if (backup._tag === "Failure")
          return yield* refuse(
            `The backup before ${steps.join(", ")} failed (${failureLine(Cause.squash(backup.cause))}); nothing applied`,
          );
        yield* print(`Backed up the pool database before ${steps.join(", ")}: ${name}`);
      }
      for (const worker of forward) {
        const moved = yield* Effect.exit(
          rollbackTo(
            at(worker.script),
            worker.version,
            "production re-point forward",
            forceSecrets,
          ),
        );
        if (moved._tag === "Failure")
          return yield* refuse(
            `Re-pointing ${worker.fqn} forward failed (${failureLine(Cause.squash(moved.cause))}); nothing applied`,
          );
      }
      // A restore of the controller's storage would be looked up by this time.
      if (created.length) yield* print(`Creating classes at ${new Date().toISOString()}`);
      const exit = yield* Effect.exit(Alchemist.Stack.apply(snapshot as never));
      if (exit._tag === "Failure") {
        const failed = tracker.context().resources.map(({ fqn, type }) => `${fqn} (${type})`);
        yield* print(
          `::error::The apply failed at ${failed.join(", ") || "no resource it reported"}: ${failureLine(Cause.squash(exit.cause))}`,
        );
      }
      return { serving, applied: exit._tag === "Success", creating: created.length > 0 };
    }),
  );
  if (mode === "plan") return;
  const { PoolAcceptanceClient } = await import("./pool-acceptance/client.ts");
  const result = applied
    ? await smoke(() =>
        new PoolAcceptanceClient().sendTurn(credential!, model, {
          id: randomUUID(),
          expectedRecords: 1,
        }),
      )
    : ({ passed: false, why: "the apply failed" } as const);
  if (result.passed)
    return void (await say(`Deployed ${candidate}; the smoke turn on ${model} served.`));
  if (creating) {
    await say(
      `::error::Failed (${result.why}). New Durable Object classes cannot be rolled back: fix forward.`,
    );
    process.exit(1);
  }
  const failed: string[] = [];
  for (const worker of serving)
    await Effect.runPromise(
      rollbackTo(at(worker.script), worker.version, "production smoke failed", forceSecrets).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    ).catch(() => failed.push(worker.fqn));
  await say(
    `::error::Failed (${result.why}); re-pointed ${serving.length - failed.length} of ${serving.length} Workers` +
      ` to their versions from before the apply${failed.length ? `; not re-pointed: ${failed.join(", ")}` : ""}.` +
      " State still records this release, so the next deploy is a new commit, not this one again.",
  );
  process.exit(1);
}

// An error's message and cause can carry hosts or derived values; the public log names its kind,
// and a provider's code with its message redacted.
if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch(async (error: unknown) => {
    const { failureLine } = await import("./release/failure-line.ts");
    await say(`::error::Stopped: ${error instanceof Refused ? error.message : failureLine(error)}`);
    process.exit(1);
  });
