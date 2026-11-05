import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { recipeHarness, root, runtime, appsManifest } from "../../e2e/recipes/harness.mjs";
import { providerAccountProduct } from "../../.upstream/e2e/support/provider-account-product.ts";
import { scenarios } from "../../.upstream/e2e/test-plan.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { handleAccountKeyMirror } from "../../src/pool/account-key-mirror.ts";
import { handleUsageSeries } from "../../src/pool/model-history/series-http.ts";
import { PoolControl } from "../../src/pool/attribution.ts";
import { HomeMembership } from "../../src/pool/home-membership.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { MemoryStorage } from "./sharing-fixture.ts";

const signingKey = "ab".repeat(32);
class Storage extends MemoryStorage {
  async getAlarm() {
    return null;
  }
  async setAlarm() {}
}

/** Full host acquisition and selection, backed by the test's real pinned Home/node. */
export async function withProviderProduct(home, work) {
  const sources = await Promise.all(
    ["openai", "anthropic", "gemini"].map(async (lab) =>
      JSON.parse(await readFile(join(root, "src/catalog/provider-apps", `${lab}.json`), "utf8")),
    ),
  );
  const control = new PoolControl(new Storage(), {
    signingKey,
    home: (path, init) => home.response(path.replace("/v8/management", ""), init),
  });
  const references = new Map();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, "http://fixture.invalid");
      let result;
      if (incoming.method === "GET" && url.pathname === "/catalog/index.json") {
        result = Response.json({
          version: 1,
          apps: sources.map((source) => ({
            id: source.package,
            package: source.package,
            name: source.package,
            description: "Synthetic provider source",
            auth: [],
            icons: [],
            source: `apps/${source.package}.json`,
          })),
        });
      } else if (
        incoming.method === "GET" &&
        sources.some((source) => url.pathname === `/catalog/apps/${source.package}.json`)
      ) {
        result = Response.json(
          sources.find((source) => url.pathname === `/catalog/apps/${source.package}.json`),
        );
      } else {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const request = new Request(url, {
          method: incoming.method,
          headers: incoming.headers,
          body: Buffer.concat(chunks),
        });
        if (url.pathname === "/pool/v1/account-mirrors") {
          const { envelope } = await request.clone().json();
          const value = await openEnvelope(signingKey, "sbam1", envelope);
          result = await handleAccountKeyMirror(request, { home, signingKey });
          if (result.ok && value.action === "upsert")
            references.set(value.credential.type, value.reference);
        } else if (url.pathname === "/pool/v1/account-acquisitions") {
          const { envelope } = await request.clone().json();
          const input = await openEnvelope(signingKey, "sbaa1", envelope);
          result = await control.acquire(request);
          if (result.ok) {
            const output = await result.clone().json();
            if (output.state === "connected") references.set(input.provider, output.ref);
          }
        } else if (url.pathname === "/pool/v1/membership") result = Response.json(null);
        else if (url.pathname === "/pool/v1/usage/last-success")
          result = await handleUsageSeries(request, { home, signingKey });
        else result = await control.handle(request);
      }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previous = process.cwd();
  process.chdir(join(root, ".upstream"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "basalt-provider-product-")),
          );
          const h = yield* recipeHarness(directory, origin, scenarios.poolSelectOnlyUi.title);
          yield* providerAccountProduct(
            origin,
            `${origin}/catalog/index.json`,
            true,
            (action, _status, body) => h.control(action, body),
          ).pipe(Effect.provideService(Target, h.target));
          const canonical = sources[0].files.find((file) => file.path === "providers.ts");
          const pool = yield* h.request("POST", `${h.prefix}/apps/deploy`, {
            name: "Native runtime pool",
            files: [
              appsManifest,
              canonical,
              {
                path: "index.ts",
                content: `import { defineApp } from "apps"; import { providers } from "./providers.ts"; export default defineApp({app:{accounts:{openai:providers.openai.many(),anthropic:providers.anthropic.many(),gemini:providers.gemini.many()}}},{});`,
              },
            ],
          });
          yield* h.control("stop");
          yield* h.control("storage/legacy", {
            database: "product",
            statements: [
              {
                sql: `update organization set metadata = jsonb_set(coalesce(metadata::jsonb, '{}'::jsonb), '{basaltPools}', $1::jsonb)::text where id = $2`,
                params: [
                  JSON.stringify({ fixture: { app: pool.id, membership: "executor-links-v1" } }),
                  h.actors.organization.id,
                ],
              },
            ],
          });
          yield* h.control("start");
          const run = (effect) => Effect.runPromise(effect);
          const installed = new Map();
          const provider = async (lab) => {
            if (!installed.has(lab))
              installed.set(
                lab,
                await run(
                  h.request("POST", `${h.prefix}/apps/install`, {
                    entry: `provider-${lab}`,
                    name: lab,
                  }),
                ),
              );
            return installed.get(lab);
          };
          const selected = new Map();
          const reconcile = async (lab, id) => {
            const links = await run(h.request("GET", `${h.appPath(pool.id)}/accounts/app`));
            if (!links.some((link) => link.requirement === lab && link.account?.id === id))
              throw new Error("Host selection did not persist");
            const method =
              lab === "openai" ? "codex" : lab === "anthropic" ? "claude" : "gemini-cli";
            const reference = references.get(method);
            if (typeof reference !== "string")
              throw new Error("Host acquisition did not retain its exact reference");
            selected.set(id, reference);
            await new HomeMembership(home).reconcile(pool.id, [...selected.values()]);
          };
          const select = async (lab, id) => {
            await run(h.request("PUT", `${h.appPath(pool.id)}/accounts/app/${lab}/${id}`));
            await reconcile(lab, id);
          };
          yield* Effect.tryPromise(() =>
            work({
              ...h,
              pool: pool.id,
              provider,
              select,
              links: (id) => run(h.request("GET", `${h.appPath(id)}/accounts/app`)),
              reconcile,
              references,
              run,
              control,
            }),
          );
        }),
      ).pipe(Effect.provide(runtime)),
    );
  } finally {
    process.chdir(previous);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
