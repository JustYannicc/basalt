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
type Plan = { resources: Record<string, PlanNode | undefined> };
type Snapshot = {
  summary: Record<string, number>;
  resources: { fqn: string; resourceType: string; action: string }[];
  native: Plan;
};

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

/**
 * Durable Object classes a Worker's last finished apply bound on itself whose binding the plan
 * deletes or no longer has. Alchemy would send them as `deleted_classes`, which deletes every
 * object of the class and its storage: never applied. An interrupted apply's row is read from the
 * generation it started from, as Alchemy compares it.
 */
export const droppedClasses = (plan: Plan) =>
  workers(plan).flatMap(([fqn, node]) => {
    const state = node.state?.status === "updating" && node.state.old ? node.state.old : node.state;
    const planned = new Map(node.bindings?.map((binding) => [binding.sid, binding.action]));
    return (state?.bindings ?? [])
      .filter((binding) => [undefined, "delete"].includes(planned.get(binding.sid)))
      .flatMap((binding) => localClasses(binding).map((name) => `${fqn}: ${name}`));
  });

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
  if (mode !== "plan" && mode !== "deploy") throw new Error("Usage: production.ts plan|deploy");
  const candidate = process.env.BASALT_RELEASE_CANDIDATE ?? "";
  if (process.env.GITHUB_ACTIONS !== "true" || !/^[a-f0-9]{40}$/u.test(candidate))
    throw new Error("Production deploys only in GitHub Actions, from a candidate's full sha");
  const model = process.env.POOL_ACCEPTANCE_MODEL ?? "";
  if (mode === "deploy" && !model) throw new Error("POOL_ACCEPTANCE_MODEL names the smoke's model");
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
  // Alchemy captures the working directory on its first load and resolves the stack's commands
  // from it; they are declared relative to the cloud app.
  process.chdir(resolve(root, ".upstream/apps/hosted/cloud"));
  const { Effect, Logger, Redacted } = await import("effect");
  const { FetchHttpClient } = await import("effect/http");
  const Alchemist = await import("alchemy/Alchemist");
  const Session = await import("alchemy/Alchemist/Session");
  const { storeCannotBootstrap } = await import("./release/state-store-guard.ts");
  const { rollbackTo, servingVersion } = await import("./release/worker-version.ts");
  const target = { entrypoint: resolve(root, "alchemy.run.ts"), stage: "production" };
  // Alchemy's own log lines name scripts and hosts; the public log gets only the lines below.
  const run = <A>(effect: Fx.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      Effect.scoped(effect).pipe(
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

  // One Alchemy session plans and applies: the snapshot holds that session's providers.
  const { serving, applied, creating } = await run(
    Effect.gen(function* () {
      yield* storeCannotBootstrap;
      type Key = { stack: string; stage: string; fqn: string };
      const store = (yield* Alchemist.State.store({
        backend: "configured",
        ...target,
      } as never)) as {
        getVersion: () => Fx.Effect<number, unknown, never>;
        get: (key: Key) => Fx.Effect<State | undefined, unknown, never>;
      };
      const version = yield* store.getVersion();
      if (version !== 8)
        return yield* Effect.die(new Error(`State store version ${version}, not 8`));
      const { stackName } = yield* Session.importStack(target.entrypoint) as unknown as Fx.Effect<
        { stackName: string },
        unknown,
        never
      >;
      const pool = yield* store.get({ stack: stackName, stage: "production", fqn: "PoolWorker" });
      const hosted = Object.keys(pool?.attr?.durableObjectNamespaces ?? {});
      const declared = classesDeclared(values["fleet-classes"] === true, hosted);
      // A version from before this run would not host the classes it creates: nothing to re-point to.
      const creating = declared && !fleetClasses.every((name) => hosted.includes(name));
      assignEnvironment(process.env, fleetEnvironment(declared));
      const snapshot = (yield* Alchemist.Stack.plan({
        target,
        operation: "deploy",
        updateStateStore: false,
      } as never)) as unknown as Snapshot;
      yield* print(
        `Plan of ${candidate}, fleet classes ${declared ? "declared" : "absent"}: ${JSON.stringify(snapshot.summary)}`,
      );
      for (const row of snapshot.resources)
        if (row.action !== "noop") yield* print(`- ${row.fqn} ${row.resourceType} ${row.action}`);
      const dropped = droppedClasses(snapshot.native);
      if (dropped.length)
        return yield* Effect.die(
          new Error(
            `The plan drops Durable Object classes (${dropped.join("; ")}); nothing applied`,
          ),
        );
      const serving: { fqn: string; script: string; version: string }[] = [];
      if (mode === "plan") return { serving, applied: false, creating };
      for (const fqn of workersToRepoint(snapshot.native)) {
        const script = String(snapshot.native.resources[fqn]!.state?.attr?.workerName ?? "");
        serving.push({ fqn, script, version: yield* servingVersion(at(script)) });
      }
      yield* print(
        `Serving before the apply: ${serving.map((w) => `${w.fqn} ${w.version}`).join(", ") || "none"}`,
      );
      const exit = yield* Effect.exit(Alchemist.Stack.apply(snapshot as never));
      return { serving, applied: exit._tag === "Success", creating };
    }),
  );
  if (mode === "plan") return;
  const { PoolAcceptanceClient } = await import("./pool-acceptance/client.ts");
  const { acceptanceCredential } = await import("./release/acceptance-device.ts");
  const result = applied
    ? await smoke(() =>
        new PoolAcceptanceClient().sendTurn(acceptanceCredential(process.env), model, {
          id: randomUUID(),
          expectedRecords: 1,
        }),
      )
    : ({ passed: false, why: "the apply failed" } as const);
  if (result.passed)
    return void (await say(`Deployed ${candidate}; the smoke turn on ${model} served.`));
  if (creating) {
    await say(
      `::error::Failed (${result.why}). The fleet's classes cannot be rolled back: fix forward.`,
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
      ` to their versions from before the apply${failed.length ? `; not re-pointed: ${failed.join(", ")}` : "."}`,
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
