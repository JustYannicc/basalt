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
type Plan = {
  resources: Record<string, PlanNode | undefined>;
  deletions?: Record<string, PlanNode | undefined>;
};
type Snapshot = {
  summary: Record<string, number>;
  resources: { fqn: string; resourceType: string; action: string }[];
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

// A rollback Cloudflare refuses over a changed secret is forced only for this one: it carries the
// upstream pin, which changes only when a release moves it, never between two ordinary releases.
const forceSecrets = new Set(["EXECUTOR_TELEMETRY"]);

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
  const candidate = process.env.BASALT_RELEASE_CANDIDATE ?? "";
  if (process.env.GITHUB_ACTIONS !== "true" || !/^[a-f0-9]{40}$/u.test(candidate))
    throw new Refused("Production deploys only in GitHub Actions, from a candidate's full sha");
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
  const { FetchHttpClient } = await import("effect/http");
  const Alchemist = await import("alchemy/Alchemist");
  const Session = await import("alchemy/Alchemist/Session");
  const { storeCannotBootstrap } = await import("./release/state-store-guard.ts");
  const { rollbackTo, servingVersion } = await import("./release/worker-version.ts");
  const { takeBackup } = await import("./release/database-safety.ts");
  const { errorKind, progressTracker } = await import("./release/public-report.ts");
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
  const refuse = (line: string) =>
    Effect.andThen(print(`::error::${line}`), Effect.fail(new Refused(line)));

  // First session: the State store's version and the classes PoolWorker hosts, before the stack
  // reads the fleet's setting.
  const hosted = await run(
    Effect.gen(function* () {
      type Key = { stack: string; stage: string; fqn: string };
      const store = (yield* Alchemist.State.store({
        backend: "configured",
        ...target,
      } as never)) as {
        getVersion: () => Fx.Effect<number, unknown, never>;
        get: (key: Key) => Fx.Effect<State | undefined, unknown, never>;
      };
      const version = yield* store.getVersion();
      if (version !== 8) return yield* refuse(`State store version ${version}, not 8`);
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
      for (const row of snapshot.resources)
        if (row.action !== "noop") yield* print(`- ${row.fqn} ${row.resourceType} ${row.action}`);
      yield* print(
        `Creates Durable Object classes (cannot be rolled back): ${created.join(", ") || "none"}`,
      );
      if (dropped.length)
        return yield* refuse(
          `The plan drops Durable Object classes (${dropped.join("; ")}); nothing applied`,
        );
      // The stack read the setting this run set, or this run stops before it applies anything.
      const fleet = created.filter((name) => fleetClasses.some((cls) => name.endsWith(`: ${cls}`)));
      if (fleet.length !== (declared && fleetClasses.some((cls) => !hosted.includes(cls)) ? 2 : 0))
        return yield* refuse(
          `The plan's fleet classes (${fleet.join(", ") || "none"}) do not match the switch`,
        );
      const serving: { fqn: string; script: string; version: string }[] = [];
      if (mode === "plan") return { serving, applied: false, creating: created.length > 0 };
      for (const fqn of workersToRepoint(snapshot.native)) {
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
            `The backup before ${steps.join(", ")} failed (${errorKind(Cause.squash(backup.cause))}); nothing applied`,
          );
        yield* print(`Backed up the pool database before ${steps.join(", ")}: ${name}`);
      }
      // A restore of the controller's storage would be looked up by this time.
      if (created.length) yield* print(`Creating classes at ${new Date().toISOString()}`);
      const exit = yield* Effect.exit(Alchemist.Stack.apply(snapshot as never));
      if (exit._tag === "Failure") {
        const failed = tracker.context().resources.map(({ fqn, type }) => `${fqn} (${type})`);
        yield* print(
          `::error::The apply failed at ${failed.join(", ") || "no resource it reported"}: ${errorKind(Cause.squash(exit.cause))}`,
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

// An error's message and cause can carry hosts or derived values; the public log names its kind.
if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch(async (error: unknown) => {
    const { errorKind } = await import("./release/public-report.ts");
    await say(`::error::Stopped: ${error instanceof Refused ? error.message : errorKind(error)}`);
    process.exit(1);
  });
