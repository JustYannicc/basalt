import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Exit, Layer } from "effect";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { createCloudScenarioActors } from "../../.upstream/e2e/support/actors.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { bundlePoolApp } from "../../scripts/pool-app-bundle.ts";
import { root } from "./harness.mjs";
import { cloudLocks } from "../../.upstream/e2e/support/cloud-locks.ts";
import { redactLogText } from "../../src/feedback/logs.ts";
import { startPoolFixture } from "./pool-fixture.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Localize the actual verified pool seed and operator config, preserving native provisioning. */
const localPoolSetup = async (directory, registry, resetOptions) => {
  const upstream = join(root, ".upstream");
  const assetDirectory = join(upstream, "apps/hosted/cloud/.generated/pool-app");
  const sourcePath = join(upstream, "apps/hosted/server/src/implementation/pool-app-source.ts");
  const source = await readFile(sourcePath);
  const accessHookPath = join(
    upstream,
    "apps/hosted/server/src/implementation/pool-access-hook.ts",
  );
  const accessHook = await readFile(accessHookPath);
  const assets = await Promise.all(
    (await readdir(assetDirectory)).map(async (name) => [
      name,
      await readFile(join(assetDirectory, name)),
    ]),
  );
  const resetPaths = resetOptions
    ? [
        "apps/hosted/cloud/src/infrastructure/executor.ts",
        "apps/hosted/cloud/src/infrastructure/product-services.ts",
      ]
    : [];
  const resetSources = await Promise.all(
    resetPaths.map(async (path) => [path, await readFile(join(upstream, path))]),
  );
  const signingKey = randomBytes(32).toString("hex");
  const catalog = resetOptions
    ? await Promise.all(
        ["openai", "anthropic"].map(async (lab) =>
          JSON.parse(
            await readFile(join(root, "src/catalog/provider-apps", `${lab}.json`), "utf8"),
          ),
        ),
      )
    : [];
  const fixture = await startPoolFixture(signingKey, { catalog });
  const previous = { path: process.env.PATH, setup: process.env.BASALT_E2E_POOL_SETUP };
  const restore = async () => {
    process.env.PATH = previous.path;
    if (previous.setup === undefined) delete process.env.BASALT_E2E_POOL_SETUP;
    else process.env.BASALT_E2E_POOL_SETUP = previous.setup;
    await fixture.stop();
    await rm(assetDirectory, { recursive: true, force: true });
    await mkdir(assetDirectory, { recursive: true });
    for (const [name, bytes] of assets) await writeFile(join(assetDirectory, name), bytes);
    await writeFile(sourcePath, source);
    await writeFile(accessHookPath, accessHook);
    for (const [path, bytes] of resetSources) await writeFile(join(upstream, path), bytes);
    await rm(join(directory, "bin"), { recursive: true, force: true });
  };
  try {
    for (const [path, bytes] of resetSources) {
      const declaration = "const poolOrigin = (yield* cloudHosts.pipe(Effect.orDie)).browser;";
      assert.equal(bytes.toString().split(declaration).length, 2);
      await writeFile(
        join(upstream, path),
        bytes
          .toString()
          .replace(declaration, `const poolOrigin = ${JSON.stringify(fixture.origin)};`),
      );
    }
    // The emulated Cloud has no outer Basalt router. Localize only that external receiver address.
    const destination = "new URL(accessPath, origin).href";
    assert.equal(accessHook.toString().split(destination).length, 2);
    await writeFile(
      accessHookPath,
      accessHook
        .toString()
        .replace(destination, `new URL(accessPath, ${JSON.stringify(fixture.origin)}).href`),
    );
    const files = bundlePoolApp(root, upstream).map((file) =>
      file.path === "deployment.ts"
        ? {
            ...file,
            content: `export const poolOrigin = ${JSON.stringify(fixture.origin)};\nexport const productName = "Synthetic pool";\n`,
          }
        : file,
    );
    const serialized = JSON.stringify(files);
    const version = createHash("sha256").update(serialized).digest("hex");
    const name = `pool-app-${version}.json`;
    await writeFile(join(assetDirectory, name), serialized);
    await writeFile(
      sourcePath,
      `export const poolAppVersion = ${JSON.stringify(version)};\nexport const poolAppAssetPath = ${JSON.stringify(`/_basalt/${name}`)};\n`,
    );
    const bin = join(directory, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(
      join(bin, "node"),
      `#!/bin/sh\nexport POOL_APP_SIGNING_KEY=${quote(signingKey)}\nexport EXECUTOR_NPM_REGISTRY=${quote(registry.url)}\nexport EXECUTOR_URL_ALLOW_LOOPBACK_HTTP=true\n${resetOptions ? `export EXECUTOR_CATALOG_URL=${quote(`${fixture.origin}/catalog/index.json`)}\n` : ""}exec ${quote(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${previous.path}`;
    process.env.BASALT_E2E_POOL_SETUP = "1";
    return { fixture, restore };
  } catch (error) {
    await restore();
    throw error;
  }
};

export const poolCloudHarness = (directory, { resets = false } = {}) =>
  Effect.gen(function* () {
    const registry = yield* lockedNpmRegistry;
    const setup = yield* Effect.acquireRelease(
      Effect.promise(() => localPoolSetup(directory, registry, resets)),
      (setup) => Effect.promise(() => setup.restore()),
    );
    const base = yield* startEnvironment({ target: "cloud", headless: true });
    const target = yield* prepareScenario(base.target, "Native pool recipe public path");
    setup.fixture.product(target.metadata.origin);
    const services = yield* Layer.build(
      SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
    );
    const api = Context.get(services, SessionClients);
    let actors = yield* createCloudScenarioActors.pipe(Effect.provideContext(services));
    // Capture before actor and environment finalizers remove the failed runtime.
    let lastApps;
    let organization;
    if (resets)
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? Effect.gen(function* () {
              const diagnostics = { runtimeDirectory: target.directory, apps: lastApps };
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const database = yield* cloudLocks.pipe(Effect.provideService(Target, target));
                  diagnostics.provisioning = yield* database.run({
                    sql: `select kind, status, attempts, available_at, updated_at from hosted_provisioning
                    where organization_id = $1 order by kind, updated_at limit 50`,
                    params: [organization ?? ""],
                  });
                }),
              ).pipe(
                Effect.timeout("3 seconds"),
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    diagnostics.provisioningUnavailable = true;
                  }),
                ),
              );
              yield* Effect.promise(async () => {
                try {
                  const log = await readFile(join(target.directory, "cloud.log"), "utf8");
                  await writeFile(
                    join(directory, "runtime-cloud.log"),
                    redactLogText(log).slice(-2 * 1024 * 1024),
                    { mode: 0o600 },
                  );
                } catch {
                  diagnostics.cloudLogUnavailable = true;
                }
                await writeFile(
                  join(directory, "runtime-diagnostics.json"),
                  JSON.stringify(diagnostics, null, 2) + "\n",
                  { mode: 0o600 },
                );
              });
            }).pipe(Effect.catchCause(() => Effect.logWarning("Reset diagnostic retention failed")))
          : Effect.void,
      );

    const raw = (role, method, path, input, headers) =>
      api.request(actors[role], method, path, input, headers);
    const requestAs = (role, method, path, input) =>
      raw(role, method, path, input).pipe(
        Effect.map((response) => {
          assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
          if (
            resets &&
            method === "GET" &&
            path === `/api/organizations/${organization}/apps` &&
            Array.isArray(response.body)
          ) {
            lastApps = {
              total: response.body.length,
              rows: response.body.slice(0, 50).map((app) => ({
                id: app.id,
                name: redactLogText(String(app.name ?? "")).slice(0, 200),
                activeVersion: app.activeVersion,
              })),
            };
          }
          return response.body;
        }),
      );
    // Fixture identities skip admission hooks. A real team creation owns default-app provisioning.
    const team = yield* requestAs("owner", "POST", "/api/auth/organization/create", {
      name: "Synthetic recipe evidence",
      slug: `recipe-${randomBytes(8).toString("hex")}`,
      keepCurrentActiveOrganization: true,
    });
    organization = team.id;
    actors = { ...actors, organization: { id: team.id, slug: team.slug } };
    for (const role of ["member"]) {
      const identity = yield* requestAs(role, "GET", "/api/auth/get-session");
      const invitation = yield* requestAs("owner", "POST", "/api/auth/organization/invite-member", {
        organizationId: team.id,
        email: identity.user.email,
        role,
      });
      yield* requestAs(role, "POST", "/api/auth/organization/accept-invitation", {
        invitationId: invitation.id,
      });
    }
    const prefix = `/api/organizations/${actors.organization.id}`;
    const appPath = (id) => `${prefix}/apps/${id}`;
    const callAs = (role, id, tool, input = {}, kind = "query") =>
      requestAs(role, "POST", `${appPath(id)}/tools/call`, { tool, input, kind });
    const approvedAs = (role, id, tool, input) =>
      Effect.gen(function* () {
        let result = yield* requestAs(role, "POST", `${appPath(id)}/tools/run`, {
          tool,
          input,
          kind: "mutation",
        });
        if (result.status === "approval-required") {
          const answer = yield* requestAs(
            role,
            "POST",
            `${appPath(id)}/tools/approvals/${result.requestId}`,
            { response: { action: "accept", content: {} } },
          );
          result = answer.result;
        }
        assert.equal(result.status, "completed", JSON.stringify(result));
        return result.value;
      });
    const connectAs = (role, id, slot, fields) =>
      Effect.gen(function* () {
        const connection = yield* requestAs(
          role,
          "POST",
          `${appPath(id)}/accounts/user/${slot}/connections`,
          {},
        );
        return yield* requestAs(role, "POST", `${prefix}/connections/${connection.id}/submit`, {
          method: "apiKey",
          fields,
        });
      });
    return {
      actors,
      prefix,
      appPath,
      origin: target.metadata.origin,
      raw,
      requestAs,
      callAs,
      approvedAs,
      connectAs,
      request: (...args) => requestAs("owner", ...args),
      call: (...args) => callAs("owner", ...args),
      approved: (...args) => approvedAs("owner", ...args),
      connect: (...args) => connectAs("owner", ...args),
      fixture: setup.fixture,
      runtimeDirectory: target.directory,
      /**
       * Make an account's next usage refresh due now, standing in for the server's refresh
       * interval passing, so the account row's own Refresh reads usage again at once.
       */
      makeObservationsDue: (account) =>
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* cloudLocks.pipe(Effect.provideService(Target, target));
            yield* database.run({
              sql: "update executor_account_observations set next_allowed_at = '1970-01-01', lease = null, lease_until = null where account = $1",
              params: [account],
            });
          }),
        ),
    };
  });
