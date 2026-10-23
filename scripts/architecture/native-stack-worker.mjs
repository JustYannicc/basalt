// Bun selects the installed packages' source exports; no provider plan/apply is run.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { declarationFetch, fixtureAccount, inventoryDeclarations } from "./native-stack-fixtures.ts";

const emit = process.stdout.write.bind(process.stdout);
// Discard all library diagnostics, including direct stream writes and console output.
process.stdout.write = process.stderr.write = () => true;
for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"])
  console[method] = () => {};

let phase = "setup";
try {
  const root = process.env.NATIVE_STACK_ROOT;
  if (!root || !process.env.ALCHEMY_HOME) throw new Error();
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  // Install a deny-all fetch before importing any project module.
  let setupRequestDenied = false;
  globalThis.fetch = async () => { setupRequestDenied = true; throw new Error("Native inventory request during setup"); };
  const { brand } = await load("brand.ts");
  if (setupRequestDenied) throw new Error();
  const http = declarationFetch(brand.zone);
  globalThis.fetch = http.fetch;
  const { deployEnvironment, requiredSecrets } = await load("scripts/environment.ts");
  const synthetic = Object.fromEntries(requiredSecrets.map(key => [key, `fixture-${key.toLowerCase()}`]));
  Object.assign(synthetic, {
    CLOUDFLARE_ACCOUNT_ID: fixtureAccount,
    CLOUDFLARE_API_TOKEN: "fixture-api-token",
    BETTER_AUTH_SECRET: "a".repeat(64), EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
    MCP_SESSION_KEY_CURRENT: "c".repeat(64), MCP_SESSION_KEY_PREVIOUS: "d".repeat(64),
    APP_DOMAIN_CONTROL_SECRET: "e".repeat(64), APP_DOMAIN_CONTROLLER_TOKEN: "fixture-app-domain-token",
    POOL_APP_SIGNING_KEY: "f".repeat(64),
  });
  const settings = deployEnvironment(synthetic);
  phase = "import";
  const [{ default: actualRoot }, { evalStack }, { AlchemyContextLive }, { provideFreshArtifactStore },
    { layerNonInteractive }, { Effect, ConfigProvider, Layer, Exit, Cause }, NodeServices, Output] = await Promise.all([
    load("alchemy.run.ts"), import("alchemy/Stack"), import("alchemy/AlchemyContext"), import("alchemy/Artifacts"),
    import("alchemy/Interaction"), import("effect"), import("@effect/platform-node/NodeServices"), import("alchemy/Output"),
  ]);
  phase = "evaluate";
  const program = evalStack(actualRoot, stack => Effect.sync(() => {
    http.assertAllowed();
    return inventoryDeclarations(Object.values(stack.resources), stack.bindings, Output.isOutput);
  }), { stage: settings.ALCHEMY_STAGE }).pipe(
    provideFreshArtifactStore,
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: settings }))),
    Effect.provide(layerNonInteractive()),
    Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.timeout("25 seconds"),
  );
  const exit = await Effect.runPromiseExit(program);
  http.assertAllowed();
  if (Exit.isFailure(exit)) {
    const diagnostic = Cause.pretty(exit.cause);
    const labels = ["Invalid native declaration name", "Invalid native declaration metadata", "Invalid native bindings", "Unknown native Worker export kind", "Unmatched native workflow export", "Invalid native binding contributions"];
    const metadata = /Invalid native declaration metadata:(record|resource|props|env|contribution|data|exports|export|binding)-(undefined|object|array|function|string|number|boolean|symbol|bigint)/.exec(diagnostic)?.[0];
    throw new Error(metadata ?? labels.find(label => diagnostic.includes(label)) ?? "evaluation");
  }
  emit(JSON.stringify(exit.value));
} catch (error) {
  // Never forward exception messages, causes, file paths, config, or request details.
  const labels = ["Invalid native declaration name", "Invalid native declaration metadata", "Invalid native bindings", "Unknown native Worker export kind", "Unmatched native workflow export", "Invalid native binding contributions"];
  const safe = labels.includes(error?.message) || /^Invalid native declaration metadata:(record|resource|props|env|contribution|data|exports|export|binding)-(undefined|object|array|function|string|number|boolean|symbol|bigint)$/.test(error?.message);
  emit(JSON.stringify({ error: `native-stack-${phase}-failed`, reason: safe ? error.message : "redacted" }));
  process.exitCode = 1;
}
