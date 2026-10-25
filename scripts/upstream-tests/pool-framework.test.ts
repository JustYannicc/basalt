import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { poolFrameworkVersion } from "../pool-app-bundle.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const { workerDependencies } = await load("packages/sdk/src/implementation/worker-dependencies.ts");

test("the hosted compiler selects its configured patched framework without npm", async () => {
  const files = new Map<string, string>([
    ["package.json", JSON.stringify({ dependencies: { apps: poolFrameworkVersion } })],
  ]);
  const filesystem = {
    read: (path: string) => files.get(path) ?? null,
    write: (path: string, content: string) => {
      files.set(path, content);
    },
    delete: (path: string) => {
      files.delete(path);
    },
    list: (prefix: string) => [...files.keys()].filter((path) => path.startsWith(prefix)),
    flush() {},
  };
  let reads = 0;
  const framework = {
    "package.json": JSON.stringify({ name: "apps", version: poolFrameworkVersion }),
    "runtime.json": "patched-framework-fixture",
  };
  const dependencies = await Effect.runPromise(
    workerDependencies(filesystem, {
      registry: "https://npm.invalid",
      apps: {
        version: poolFrameworkVersion,
        files: Effect.sync(() => {
          reads++;
          return framework;
        }),
      },
    }),
  );
  assert.equal(await Effect.runPromise((dependencies as { framework: Effect.Effect<boolean, unknown> }).framework), true);
  assert.equal(reads, 1);
  // framework.release returns this shared host version.
  const { appsVersion } = await load("packages/app-templates/src/implementation/files.ts");
  assert.equal(appsVersion, poolFrameworkVersion);
  assert.equal(files.get("node_modules/apps/runtime.json"), "patched-framework-fixture");
  assert.equal(
    JSON.parse(readFileSync(resolve(upstream, "packages/apps/package.json"), "utf8")).version,
    poolFrameworkVersion,
  );
});

test(
  "built production framework speaks protocol 15 and preserves callers in UI and tool dispatch",
  {
    skip:
      process.env.BASALT_CHECK_BUILT_FRAMEWORK !== "1"
        ? "npm run build runs this against its framework assets"
        : false,
  },
  async () => {
    const files: Record<string, string> = JSON.parse(
      readFileSync(resolve(upstream, ".local/basalt-framework/framework.json"), "utf8"),
    );
    const manifest = JSON.parse(files["package.json"]!);
    const runtime = JSON.parse(files["runtime.json"]!);
    assert.equal(manifest.version, poolFrameworkVersion);
    assert.equal(runtime.version, poolFrameworkVersion);
    assert.equal(runtime.protocol, 15);
    assert.equal(JSON.parse(files["framework-reference.json"]!).version, poolFrameworkVersion);
    const { appProtocol } = await load("packages/sdk/src/implementation/app-protocols.ts");
    await Effect.runPromise(appProtocol(runtime.protocol));
    const author = await load("packages/apps/dist/js/index.js");
    const host = await load("packages/apps/dist/js/host.js");
    const handler = host.createAppHandler(
      author.defineApp(
        {},
        {
          tools: author.router({
            who: author.query(
              { input: author.object({}) },
              async (ctx: { user?: { id?: string } }) => ctx.user?.id ?? null,
            ),
          }),
        },
      ),
    );
    for (const caller of ["person-a", "person-b"]) {
      for (const operation of ["call", "query"]) {
        const response = await handler(
          new Request("https://app.invalid", {
            method: "POST",
            body: JSON.stringify({
              operation,
              ...(operation === "call" ? { tool: "who" } : { name: "who" }),
              input: {},
            }),
          }),
          host.hostContext({ app: {} }, undefined, caller),
        );
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.deepEqual(body, { ok: true, value: caller });
      }
    }
  },
);
