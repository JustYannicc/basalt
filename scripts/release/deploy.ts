/**
 * The only way anything in this account is applied or destroyed: Alchemy's own plan, the checks no
 * tool provides, then Alchemy's own apply of the same snapshot. `alchemy deploy` makes the same
 * calls (Cli/commands/deploy.ts:192-228), but its `--yes` also sets `updateStateStore`, so a short
 * `/version` failure could redeploy the shared State store and rotate its token. Here that is
 * always false, and the run stops before planning unless a store bootstrap provably cannot happen.
 *
 *   bun scripts/release/deploy.ts plan     --stage <s> [--config <f>] [--policy <f>] [--include <fqn>]...
 *   bun scripts/release/deploy.ts apply    --stage <s> [--config <f>] [--policy <f>] [--include <fqn>]... --plan-digest <sha256> --attempt <id>
 *   bun scripts/release/deploy.ts deploy   --stage test-… [--config <f>] [--policy <f>] [--include <fqn>]...  (plan, check, apply in one run)
 *   bun scripts/release/deploy.ts destroy  --stage test-… [--config <f>]
 *   bun scripts/release/deploy.ts backup   --stage production --name <backup name>
 *   bun scripts/release/deploy.ts snapshot --stage <s> --out <file>
 *   bun scripts/release/deploy.ts compare  --before <file> --after <file>
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type * as Fx from "effect/Effect";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cloud = resolve(root, ".upstream/apps/hosted/cloud");
const configs = [
  "alchemy.run.ts",
  "scripts/preview/stack/alchemy.database.ts",
  "scripts/preview/stack/alchemy.cleanup.ts",
];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: "string" },
    config: { type: "string" },
    policy: { type: "string" },
    include: { type: "string", multiple: true },
    "plan-digest": { type: "string" },
    attempt: { type: "string" },
    name: { type: "string" },
    out: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    fqn: { type: "string" },
    expect: { type: "string" },
    light: { type: "boolean" },
    to: { type: "string" },
  },
});
const command = positionals[0] ?? "";
const stage = values.stage ?? "";
// Accept a config relative to the working directory (the cloud dir, as previews call it) or the repo root.
// The scale test deploys a frozen candidate with this checkout's scale stack, matched by its path suffix.
const config = values.config
  ? ([relative(root, resolve(values.config)), relative(root, resolve(root, values.config))].find(
      (path) => configs.includes(path),
    ) ??
    (resolve(values.config).endsWith("/scripts/scale-test/stack.ts")
      ? resolve(values.config)
      : values.config))
  : "alchemy.run.ts";
const scaleStack = config.endsWith("/scripts/scale-test/stack.ts");
if (!configs.includes(config) && !scaleStack) throw new Error(`Unknown stack config ${config}`);

if (command !== "compare") {
  if (stage === "production") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      !/^[a-f0-9]{40}$/u.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
    )
      throw new Error("Production releases run only in GitHub Actions on an immutable candidate");
    if (command === "destroy") throw new Error("Production is never destroyed");
    if (command === "deploy") throw new Error("Production applies only a reviewed plan digest");
  } else if (scaleStack ? !/^scale-[0-9]+$/u.test(stage) : !/^test-[a-z0-9-]+$/u.test(stage)) {
    throw new Error(
      "Use --stage production, a disposable test-* stage, or scale-<n> for the scale stack",
    );
  }
}

const summary = async (text: string) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
};
const output = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

if (command === "compare") {
  const { Effect, Schema } = await import("effect");
  const { compareSnapshots, DatabaseSnapshot } = await import("./database-safety.ts");
  const read = async (path: string | undefined) =>
    Schema.decodeUnknownSync(DatabaseSnapshot)(
      JSON.parse(await readFile(resolve(path ?? ""), "utf8")),
    );
  await Effect.runPromise(compareSnapshots(await read(values.before), await read(values.after)));
  await summary("Database counts: unchanged or grown; Home's schema version unchanged.");
  process.exit(0);
}

if (command === "accept") {
  // Plain HTTP through the public pool; needs no Alchemy and touches nothing it could change.
  const { runAcceptance } = await import("./acceptance.ts");
  const { PoolAcceptanceClient } = await import("../pool-acceptance/client.ts");
  const expect = values.expect ?? "same-boot";
  if (!["same-boot", "two-runtimes", "any"].includes(expect))
    throw new Error(`Unknown --expect ${expect}`);
  const result = await runAcceptance({
    apiKey: process.env.POOL_ACCEPTANCE_KEY ?? "",
    ...(process.env.POOL_ACCEPTANCE_MODEL ? { model: process.env.POOL_ACCEPTANCE_MODEL } : {}),
    expect: expect as "same-boot",
    ...(process.env.POOL_ACCEPTANCE_ORIGIN
      ? { client: new PoolAcceptanceClient({ origin: process.env.POOL_ACCEPTANCE_ORIGIN }) }
      : {}),
  });
  if (values.out) await output(resolve(values.out), result);
  await summary(`Acceptance ${result.passed ? "passed" : "FAILED"}: ${JSON.stringify(result)}`);
  process.exit(result.passed ? 0 : 1);
}

if (command === "db-load") {
  const { Effect, Redacted } = await import("effect");
  const { FetchHttpClient } = await import("effect/http");
  const { assertPrimaryCpuBelow } = await import("./database-safety.ts");
  const reading = await Effect.runPromise(
    assertPrimaryCpuBelow({
      organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
      tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
      token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
      database: "basalt",
      branch: "main",
      ceiling: 60,
      now: Date.now(),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  await summary(
    `Pool database primary CPU ${reading.cpuPercent.toFixed(1)}% at ${reading.at}: under 60%.`,
  );
  process.exit(0);
}

// The PoolDatabase command re-runs per attempt, so plan and apply share one attempt id.
const attempt = values.attempt ?? (command === "apply" ? "" : randomUUID());
if (command === "apply" && !/^[0-9a-f-]{36}$/u.test(attempt))
  throw new Error("--attempt <id printed by the plan run> is required");
if (stage === "production") {
  const { deployEnvironment } = await import("../environment.ts");
  // Production always declares the legacy root by its pinned digest (src/pool/root-image-pin.ts).
  Object.assign(process.env, deployEnvironment(), { POOL_ROOT_IMAGE_REQUIRED: "true" });
}
// CI makes every State store bootstrap branch die rather than prompt (StateStore/State.ts:231-238).
Object.assign(process.env, { BASALT_RELEASE_ATTEMPT: attempt, ALCHEMY_STAGE: stage, CI: "true" });

const policy = values.policy
  ? JSON.parse(await readFile(resolve(values.policy), "utf8"))
  : undefined;
// A policy may only switch the cutover's declaration settings, never supply other configuration.
for (const [name, value] of Object.entries((policy?.env ?? {}) as Record<string, unknown>)) {
  if (
    !["POOL_FLEET_BUILD", "POOL_FLEET_CLASSES", "POOL_WORKER_VERSION_TRAFFIC"].includes(name) ||
    typeof value !== "string"
  )
    throw new Error(`Policy may not set ${name}`);
  process.env[name] = value;
}
const include: string[] = values.include?.length ? values.include : (policy?.include ?? []);
if (stage === "production" && !policy) throw new Error("Production needs a policy");

process.chdir(cloud);
const { Effect } = await import("effect");
const { Redacted } = await import("effect");
const WireGuard = await import("./wire-guard.ts");
const { checkPlan, decodePlanPolicy, planDigest } = await import("./plan-check.ts");
const Alchemist = await import("alchemy/Alchemist");
const { storeCannotBootstrap } = await import("./state-store-guard.ts");
const { liveMainModuleSha256 } = await import("./live-module.ts");
const { rollbackTo, servingVersion } = await import("./worker-version.ts");
const liveModules: { fqn: string; digest: string }[] = [];
const database = await import("./database-safety.ts");

// Alchemy's progress events, kept so every run's full sequence survives in the artifact. Only short
// identifying fields are kept; props and outputs never are.
const events: string[] = [];
const keep = [
  "_tag",
  "id",
  "fqn",
  "logicalId",
  "status",
  "phase",
  "action",
  "resourceType",
  "kind",
  "message",
];
const reporter = (event: unknown) =>
  Effect.sync(() => {
    const line = JSON.stringify(
      Object.fromEntries(
        Object.entries(event as Record<string, unknown>)
          .filter(
            ([key, value]) =>
              keep.includes(key) && ["string", "number", "boolean"].includes(typeof value),
          )
          .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 300) : value]),
      ),
    );
    events.push(line);
    console.log(line);
  });

let journal: ReadonlyArray<{ method: string; host: string; path: string }> = [];
const run = <A>(effect: Fx.Effect<A, unknown, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Installed before any Alchemy layer is built: Effect caches the default fetch on first read.
        // The class change must re-upload the live code byte for byte (R2); the guard compares it.
        // Script names carry the stage, so policies name FQNs and the State rows supply the names.
        const wire = {
          sqliteClasses: {} as Record<string, ReadonlyArray<string>>,
          mainModuleSha256: {} as Record<string, string>,
          // A fresh disposable stage creates every class on its first deploy; production never does.
          anyNewSqliteClass: stage !== "production" && !policy,
        };
        const guard = yield* WireGuard.install(wire);
        journal = guard.journal;
        const guarded = Effect.gen(function* () {
          yield* WireGuard.selfTest();
          yield* storeCannotBootstrap;
          for (const [fqn, classes] of Object.entries(
            (policy?.wire?.sqliteClasses ?? {}) as Record<string, string[]>,
          ))
            wire.sqliteClasses[yield* scriptName(fqn)] = classes;
          for (const fqn of (policy?.wire?.expectLiveModule ?? []) as string[]) {
            const script = yield* scriptName(fqn);
            const digest = yield* liveMainModuleSha256({
              accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
              token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
              script,
            });
            wire.mainModuleSha256[script] = digest;
            liveModules.push({ fqn, digest });
          }
          // A refused request fails the run at once instead of after the SDK's retries.
          return yield* Effect.raceFirst(
            effect.pipe(Effect.provideService(Alchemist.Progress, reporter)) as Fx.Effect<
              A,
              unknown,
              never
            >,
            guard.refused as Fx.Effect<never, unknown, never>,
          );
        });
        return yield* guarded.pipe(
          Effect.provide(Alchemist.layer()),
          Effect.provide(guard.layer),
        ) as Fx.Effect<A, unknown, never>;
      }),
    ) as Fx.Effect<A, unknown, never>,
  );

const target = { entrypoint: scaleStack ? config : resolve(root, config), stage };
/** A Worker's live script name, from its State row (names carry the stage, policies name FQNs). */
const scriptName = (fqn: string) =>
  Effect.gen(function* () {
    const state = yield* Alchemist.State.store({
      backend: "configured",
      ...target,
    } as never) as unknown as Fx.Effect<any, unknown, never>;
    const row = yield* state.get({ stack: "basalt", stage, fqn }) as Fx.Effect<any, unknown, never>;
    const script = row?.attr?.workerName;
    if (typeof script !== "string" || !script)
      return yield* Effect.die(new Error(`No live script name recorded for ${fqn}`));
    return script as string;
  });

const planOf = (operation: "deploy" | "destroy") =>
  Alchemist.Stack.plan({
    target,
    operation,
    updateStateStore: false,
    ...(operation === "deploy" && include.length ? { include } : {}),
  } as never) as unknown as Fx.Effect<any, unknown, never>;

/** Non-noop rows, with only the names of changed top-level props (values can be secrets). */
const changes = (snapshot: any) =>
  snapshot.resources
    .filter(
      (row: any) =>
        row.action !== "noop" || row.bindings.some((binding: any) => binding.action !== "noop"),
    )
    .map((row: any) => {
      const node = snapshot.native.resources[row.fqn] ?? snapshot.native.deletions[row.fqn];
      const before = node?.state?.props ?? {};
      const after = node?.props ?? {};
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      );
      return {
        fqn: row.fqn,
        type: row.resourceType,
        action: row.action,
        changedProps: changed.sort(),
        bindings: row.bindings.filter((binding: any) => binding.action !== "noop"),
      };
    });

const checkPolicy = () => {
  if (!policy?.check) return undefined;
  const pin = process.env.POOL_ROOT_IMAGE ? JSON.parse(process.env.POOL_ROOT_IMAGE) : undefined;
  return {
    ...policy.check,
    poolContainer: { ...policy.check.poolContainer, image: pin?.image ?? "" },
    ...(include.length ? { include } : {}),
  };
};

try {
  if (command === "plan" || command === "apply" || command === "deploy") {
    const result = await run(
      Effect.gen(function* () {
        const snapshot = yield* planOf("deploy");
        const checked = checkPolicy();
        if (checked) yield* checkPlan(snapshot.native, yield* decodePlanPolicy(checked));
        const digest = planDigest(snapshot.native);
        if (command === "plan") return { snapshot, digest };
        if (command === "apply" && values["plan-digest"] !== digest)
          return yield* Effect.die(
            new Error(
              `The plan changed since review: reviewed ${values["plan-digest"]}, now ${digest}`,
            ),
          );
        yield* Alchemist.Stack.apply(snapshot);
        const after = yield* planOf("deploy");
        if (Alchemist.Stack.hasChanges(after.summary))
          return yield* Effect.die(
            new Error(`Changes remain after apply: ${JSON.stringify(changes(after))}`),
          );
        return { snapshot, digest };
      }),
    );
    const record = {
      liveModules,
      stage,
      config,
      include,
      attempt,
      digest: result.digest,
      summary: result.snapshot.summary,
      changes: changes(result.snapshot),
    };
    await output(resolve(root, `.local/release/${command}.json`), record);
    await summary(
      `${command === "plan" ? "Planned" : "Applied; a fresh plan is all noop"}: digest \`${result.digest}\`, attempt \`${attempt}\``,
    );
    await summary(`\`\`\`json\n${JSON.stringify(record.changes, null, 2)}\n\`\`\``);
  } else if (command === "destroy") {
    await run(
      Effect.gen(function* () {
        yield* Alchemist.Stack.apply(yield* planOf("destroy"));
      }),
    );
    await summary(`Destroyed ${config} on stage ${stage}.`);
  } else if (command === "backup") {
    if (stage !== "production") throw new Error("Backups are taken of production only");
    const backup = await run(
      database.takeBackup({
        organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
        tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
        token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
        database: "basalt",
        branch: "main",
        name: values.name ?? "",
      }),
    );
    await summary(`PlanetScale backup complete: \`${backup.name}\``);
  } else if (command === "serving" || command === "rollback") {
    // A code-only release records the serving version first; on a failed acceptance it goes back to it.
    const fqn = values.fqn ?? "PoolWorker";
    const result = await run(
      Effect.gen(function* () {
        const script = yield* scriptName(fqn);
        const at = {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
          script,
        };
        if (command === "serving") return { fqn, version: yield* servingVersion(at) };
        if (!values.to) return yield* Effect.die(new Error("--to <version id> is required"));
        yield* rollbackTo(
          at,
          values.to,
          `release rollback ${process.env.GITHUB_RUN_ID ?? "local"}`,
        );
        return { fqn, version: values.to, rolledBack: true };
      }),
    );
    if (values.out) await output(resolve(values.out), result);
    await summary(
      `${command === "serving" ? "Serving" : "Rolled back to"}: ${JSON.stringify(result)}`,
    );
  } else if (command === "snapshot") {
    const snapshot = await run(
      Effect.gen(function* () {
        const state = yield* Alchemist.State.store({
          backend: "configured",
          ...target,
        } as never) as unknown as Fx.Effect<any, unknown, never>;
        const url = yield* database.poolDatabaseUrl(state, { name: "basalt", stage });
        const session = yield* database.connect(url);
        return yield* database.readSnapshot(session, { history: !values.light });
      }),
    );
    await output(resolve(values.out ?? ""), snapshot);
    await summary(`Database counts: ${JSON.stringify(snapshot)}`);
  } else {
    throw new Error(`Unknown command ${command || "(none)"}`);
  }
} finally {
  if (events.length) await mkdir(resolve(root, ".local/release"), { recursive: true });
  if (events.length)
    await writeFile(
      resolve(root, `.local/release/${command}-events.jsonl`),
      `${events.join("\n")}\n`,
    ).catch(() => {});
  if (journal.length)
    await summary(
      `Outgoing requests:\n${journal.map((entry) => `${entry.method} ${entry.host}${entry.path}`).join("\n")}`,
    );
}
