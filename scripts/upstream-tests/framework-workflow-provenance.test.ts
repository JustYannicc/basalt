import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { Schema } from "effect";
import { HostAccounts } from "../../.upstream/packages/apps/src/contracts/host.ts";
import { compileFrameworkFixture } from "./framework-public-compiler-fixture.ts";
import { authored, host, question } from "./framework-workflow-fixture.ts";
import type { LoadedWorkerBuild } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "native Workflow event waits preserve the caller and resolve current step accounts before authored writes",
  {
    skip:
      process.env.BASALT_CHECK_BUILT_FRAMEWORK !== "1"
        ? "The production framework build runs this proof"
        : false,
    timeout: 30_000,
  },
  async (context) => {
    const loaded = await compileFrameworkFixture(authored);
    const wasm = new Map<string, Buffer>();
    const bundle = await build({
      stdin: { contents: host, sourcefile: "workflow-host.ts", resolveDir: upstream, loader: "ts" },
      absWorkingDir: upstream,
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      external: ["cloudflare:*"],
      logLevel: "silent",
      plugins: [
        {
          name: "workflow-host-wasm",
          setup(builder) {
            builder.onResolve({ filter: /\.wasm$/ }, (args) => {
              const path = args.path.startsWith(".")
                ? resolve(args.resolveDir, args.path)
                : createRequire(resolve(args.resolveDir, "wasm-resolution.mjs")).resolve(args.path);
              const name = `workflow-${wasm.size}.wasm`;
              wasm.set(name, readFileSync(path));
              return { path: `./${name}`, external: true };
            });
          },
        },
      ],
    });
    let provider: unknown;
    const accounts = (region: string) =>
      Schema.decodeUnknownSync(HostAccounts)({
        app: {},
        user: {
          service: {
            id: "acc_workflow_fixture",
            provider,
            method: "key",
            fields: { region, token: "synthetic-" + region },
          },
        },
      });
    const records = new Map<
      string,
      {
        loaded: LoadedWorkerBuild;
        region: string;
        answered: boolean;
        contexts: number;
        finish?: unknown;
        parked: ReturnType<typeof deferred<void>>;
        terminal: ReturnType<typeof deferred<{ run: string; output?: unknown; error?: string }>>;
      }
    >();
    const writes: unknown[] = [];
    const runtime = new Miniflare({
      modules: [
        { type: "ESModule", path: "workflow-host.mjs", contents: bundle.outputFiles[0]!.text },
        ...Array.from(wasm, ([path, contents]) => ({
          type: "CompiledWasm" as const,
          path,
          contents,
        })),
      ],
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      durableObjects: { DATA: { className: "AppDataSupervisor", useSQLite: true } },
      workflows: { RUNS: { name: "provenance-fixture", className: "AppWorkflows" } },
      bindings: {
        AUTH: "synthetic",
        CREDENTIAL_SECRET: "synthetic-workflow-key",
        APPS_PRIVATE_FETCH: false,
        SELF_ORIGIN: "",
        NPM_REGISTRY: "",
      },
      serviceBindings: {
        PUBLIC_FETCH: async (request: Request) => {
          writes.push(JSON.parse(await request.text()));
          return new Response("recorded");
        },
        OBSERVER: async (request: Request) => {
          const value = (await request.json()) as { run: string; output?: unknown; error?: string };
          if (new URL(request.url).pathname === "/parked") records.get(value.run)!.parked.resolve();
          else records.get(value.run)!.terminal.resolve(value);
          return new Response("observed");
        },
        HOST: async (request: Request) => {
          const input = (await request.json()) as {
            operation: string;
            run: string;
            command?: { operation: string };
            result?: unknown;
          };
          const record = records.get(input.run)!;
          let value: unknown;
          switch (input.operation) {
            case "prepare":
              value = {
                state: "execute",
                caller: "workflow-owner",
                accounts: accounts("prepared"),
                seed: {
                  runId: input.run,
                  app: "app_workflow_fixture",
                  build: "bld_" + input.run,
                  version: "dpl_workflow_fixture",
                  name: "inspect",
                  input: {},
                },
              };
              break;
            case "load":
              value = record.loaded;
              break;
            case "context":
              record.contexts++;
              value = accounts(record.region);
              break;
            case "input":
              assert.equal(input.command?.operation, "get");
              value = {
                id: question,
                run: input.run,
                app: "app_workflow_fixture",
                workflow: "inspect",
                name: "hold",
                status: record.answered ? "answered" : "pending",
                expiresAt: Date.now() + 60_000,
                form: {
                  mode: "form",
                  message: "Continue",
                  requestedSchema: { type: "object", properties: {} },
                },
                evidence: [],
                links: [],
                ...(record.answered ? { response: { action: "accept", content: {} } } : {}),
              };
              break;
            case "finish":
              record.finish = input.result;
              value = null;
              break;
            default:
              throw new Error("Unexpected Workflow host operation " + input.operation);
          }
          return Response.json({ ok: true, value });
        },
      },
    });
    context.after(() => runtime.dispose());
    const command = async (operation: string, run: string) => {
      const response = await runtime.dispatchFetch("https://workflow.test", {
        method: "POST",
        body: JSON.stringify({ operation, run, event: question }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ status: string }>;
    };
    const start = (selected: LoadedWorkerBuild) => {
      const run = "wfr_" + crypto.randomUUID().replaceAll("-", "");
      const record = {
        loaded: selected,
        region: "before",
        answered: false,
        contexts: 0,
        parked: deferred<void>(),
        terminal: deferred<{ run: string; output?: unknown; error?: string }>(),
      };
      records.set(run, record);
      return { run, record };
    };
    const declaration = await runtime.dispatchFetch("https://workflow.test", {
      method: "POST",
      body: JSON.stringify({ operation: "declare", loaded }),
    });
    const declared = Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Literal(true),
        value: Schema.Struct({
          accounts: Schema.Struct({
            user: Schema.Record(Schema.String, Schema.Struct({ definition: Schema.Unknown })),
          }),
        }),
      }),
    )(await declaration.json());
    provider = declared.value.accounts.user.service!.definition;
    accounts("fixture-check");
    const { run, record } = start(loaded);
    await command("create", run);
    await Promise.race([
      record.parked.promise,
      record.terminal.promise.then((value) => assert.fail(JSON.stringify(value))),
    ]);
    assert.deepEqual(writes, [{ caller: "workflow-owner", region: "before" }]);
    record.region = "after";
    record.answered = true;
    assert.equal(writes.length, 1);
    await command("signal", run);
    const completed = await record.terminal.promise;
    assert.equal(completed.error, undefined);
    assert.deepEqual(completed.output, {
      first: { caller: "workflow-owner", region: "before" },
      second: { caller: "workflow-owner", region: "after" },
    });
    assert.equal(record.contexts, 2);
    assert.equal(writes.length, 2);
    const { framework } = loaded;
    assert.ok(framework);
    const { framework: _framework, ...missing } = loaded;
    const invalidBuilds: Array<[LoadedWorkerBuild, string]> = [
      [missing, "missing-identity"],
      [
        {
          ...loaded,
          framework: { ...framework, version: "0.0.1-beta.122", protocol: 14 },
          protocol: 14,
        },
        "unknown-identity",
      ],
      [
        {
          ...loaded,
          framework: { ...framework, source: { ...framework.source, revision: "forged" } },
        },
        "conflicting-lineage",
      ],
      [
        { ...loaded, modules: { ...loaded.modules, "node_modules/apps/index.js": "corrupt" } },
        "content-mismatch",
      ],
      [{ ...loaded, protocol: 14 }, "protocol-mismatch"],
    ];
    for (const [invalid, reason] of invalidBuilds) {
      const bad = start(invalid);
      await command("create", bad.run);
      const refused = await bad.record.terminal.promise;
      assert.ok(refused.error);
      const error = Schema.decodeUnknownSync(
        Schema.Struct({
          _tag: Schema.Literal("WorkflowFailure"),
          reason: Schema.Literal("execution"),
          retryable: Schema.Literal(false),
          errorName: Schema.Literal("FrameworkProvenanceRefused"),
          message: Schema.String,
        }),
      )(JSON.parse(refused.error));
      assert.ok(error.message.includes(reason), error.message);
      const finished = Schema.decodeUnknownSync(
        Schema.Struct({
          ok: Schema.Literal(false),
          error: Schema.Literal("execution"),
          detail: Schema.Struct({
            errorName: Schema.Literal("FrameworkProvenanceRefused"),
            message: Schema.String,
          }),
        }),
      )(records.get(bad.run)!.finish);
      assert.equal(finished.detail.message, error.message);
      assert.equal(bad.record.contexts, 0);
      assert.equal(writes.length, 2);
    }
  },
);
