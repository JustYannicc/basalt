import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../.upstream/e2e/support/api.ts";
import { localNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { handleCatalog } from "../src/catalog/worker.ts";
import { catalog } from "../src/catalog/settings.ts";

/**
 * Build every package the catalog serves, as the catalog serves it, on the framework Basalt ships:
 * each one is deployed through a real server and removed. A package that fails is also built as its
 * publisher serves it, so a failure the served framework causes is told apart from a package that
 * does not build anyway. Every failure must be listed, with its reason, in known-failures.json.
 *
 * Usage: bun e2e/catalog-compat.mjs <output directory> [limit] [concurrency]
 */
const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(process.argv[2] ?? join(root, ".generated/catalog-compat", randomBytes(6).toString("hex")));
// A positive limit builds only that many packages, for a quick check; anything else builds all.
const limit = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : Infinity;
const concurrency = Number(process.argv[4] ?? "4");
await mkdir(directory, { recursive: true, mode: 0o700 });
const known = JSON.parse(await readFile(join(root, "scripts/catalog-compat/known-failures.json"), "utf8"));
process.chdir(upstream);

const origin = "https://catalog.invalid";
const served = async (path) => handleCatalog(new Request(`${origin}${catalog.path}${path}`));
const publisher = async (path) => fetch(new URL(path, catalog.official));

// Results as each package finishes, so a run that stops early keeps what it found.
const results = [];
const program = Effect.gen(function* () {
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* localNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Catalog packages build on the served framework");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({ executable: process.execPath, upstream, target: prepared, authSecret, directory }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
  });
  const target = Target.of({
    ...prepared,
    controlOrigin: server.controlOrigin,
    metadata: { ...prepared.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))));
  const api = Context.get(services, SessionClients);
  const session = yield* api.session(Redacted.make(actors.owner.cookies));
  const prefix = `/api/organizations/${actors.organization.id}`;
  /** Deploy one package and remove it; the build's failure, or undefined when it built. */
  const build = (name, files) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(session, "POST", `${prefix}/apps/deploy`, { name, files });
      if (deployed.status !== 200) {
        const body = deployed.body ?? {};
        return `${body._tag ?? deployed.status}${body.stage ? ` at ${body.stage}` : ""}: ${String(body.message ?? "").slice(0, 300)}`;
      }
      yield* api.request(session, "DELETE", `${prefix}/apps/${deployed.body.id}`);
      return undefined;
    }).pipe(Effect.catchCause((cause) => Effect.succeed(`request failed: ${String(cause).slice(0, 200)}`)));

  const index = yield* Effect.promise(async () => (await served("index.json")).json());
  const entries = index.apps.slice(0, limit);
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => served(entry.source));
        if (response.status === 503) return { id: entry.id, skipped: "not set up in this environment" };
        if (response.status !== 200) return { id: entry.id, servedFailure: `catalog answered ${response.status}` };
        const source = yield* Effect.promise(() => response.json());
        const failure = yield* build(`Compat ${entry.id}`.slice(0, 60), source.files);
        if (failure === undefined) return { id: entry.id, built: true };
        // Only an official package has a publisher's version to compare with.
        const original = yield* Effect.promise(() => publisher(entry.source).catch(() => undefined));
        const originalFailure =
          original === undefined || original.status !== 200
            ? "no publisher source"
            : yield* build(`Compat ${entry.id} original`.slice(0, 60), (yield* Effect.promise(() => original.json())).files);
        return { id: entry.id, built: false, failure, originalBuilt: originalFailure === undefined, originalFailure };
      }).pipe(Effect.tap((result) => Effect.sync(() => results.push(result)))),
    { concurrency },
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
} catch (error) {
  await writeFile(join(directory, "partial-results.json"), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Catalog compatibility run failed; private diagnostics retained.");
  process.exit(1);
}
const failed = results.filter((result) => result.built === false || result.servedFailure !== undefined);
const regressions = failed.filter((result) => result.originalBuilt === true).map((result) => result.id);
const unlisted = failed.filter((result) => !Object.hasOwn(known, result.id)).map((result) => result.id);
const fixed = Object.keys(known).filter((id) => results.some((result) => result.id === id && result.built === true));
const report = { framework: catalog.framework, total: results.length, built: results.filter((r) => r.built).length, failed: failed.length, regressions, unlisted, fixed, results };
await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ total: report.total, built: report.built, failed: report.failed, regressions, unlisted, fixed, directory }));
// The served framework must not break a package that builds as published, and every failure is listed.
if (regressions.length > 0 || unlisted.length > 0 || fixed.length > 0) process.exitCode = 1;
// A full run that reads almost nothing proves nothing; the official feed lists well over a thousand.
if (limit === Infinity && report.total < 1000) {
  console.error(`Only ${report.total} catalog packages were read.`);
  process.exitCode = 1;
}
