// Bun selects the installed packages' source exports; no provider plan/apply is run.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  declarationFetch,
  fixtureAccount,
  inventoryDeclarations,
} from "./native-stack-fixtures.ts";

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
  globalThis.fetch = async () => {
    setupRequestDenied = true;
    throw new Error("Native inventory request during setup");
  };
  const { brand } = await load("brand.ts");
  if (setupRequestDenied) throw new Error();
  const settlesProof = process.env.NATIVE_STACK_SETTLES_PROOF;
  const previewStack = settlesProof === "preview";
  const http = declarationFetch(previewStack ? "preview.fixture.invalid" : brand.zone);
  globalThis.fetch = http.fetch;
  if (settlesProof)
    // A test stage seeds its private billing instance while its declaration is resolved. The plan
    // proof answers that one request; every other request still meets the declaration fixtures.
    globalThis.fetch = (input, init) => {
      const request = input instanceof Request ? input : undefined;
      return (init?.method ?? request?.method) === "POST" &&
        /^https:\/\/emulators\.dev\/[^?#]+\/_emulate\/seed$/.test(String(request?.url ?? input))
        ? Promise.resolve(Response.json({}))
        : http.fetch(input, init);
    };
  const { deployEnvironment, previewEnvironment, requiredSecrets } =
    await load("scripts/environment.ts");
  const synthetic = Object.fromEntries(
    requiredSecrets.map((key) => [key, `fixture-${key.toLowerCase()}`]),
  );
  Object.assign(synthetic, {
    CLOUDFLARE_ACCOUNT_ID: fixtureAccount,
    CLOUDFLARE_API_TOKEN: "fixture-api-token",
    BETTER_AUTH_SECRET: "a".repeat(64),
    EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
    MCP_SESSION_KEY_CURRENT: "c".repeat(64),
    MCP_SESSION_KEY_PREVIOUS: "d".repeat(64),
    APP_DOMAIN_CONTROL_SECRET: "e".repeat(64),
    APP_DOMAIN_CONTROLLER_TOKEN: "fixture-app-domain-token",
    POOL_APP_SIGNING_KEY: "f".repeat(64),
    POOL_DEPLOYMENT_KEY: "a".repeat(64),
    // Production always declares the root by its pinned digest.
    POOL_ROOT_IMAGE: JSON.stringify({
      image: `registry.cloudflare.com/${fixtureAccount}/basalt-pool@sha256:${"e".repeat(64)}`,
      input: "0123456789abcdef",
    }),
    GITHUB_SHA: "a".repeat(40),
    BASALT_RELEASE_ATTEMPT: "00000000-0000-4000-8000-000000000001",
    SENTRY_DSN: "https://fixture_public_key@o0.ingest.de.sentry.io/123456",
    SENTRY_OTLP_ENDPOINT: "https://o0.ingest.de.sentry.io/api/123456/integration/otlp/v1/traces",
    POSTHOG_PROJECT_KEY: "fixture_posthog_project_key",
    POSTHOG_HOST: "https://us.i.posthog.com",
  });
  const settings = previewStack
    ? {
        ...previewEnvironment(1, {
          ...synthetic,
          TEST_STAGE_DOMAIN: "preview.fixture.invalid",
          PREVIEW_STATE_KEY: "a".repeat(64),
          PREVIEW_SMOKE_EMAIL: "fixture@example.invalid",
          PREVIEW_SMOKE_PASSWORD: "fixture-password-123456",
        }).deploy,
        PREVIEW_SMOKE_EMAIL: "fixture@example.invalid",
        PREVIEW_SMOKE_PASSWORD: "fixture-password-123456",
        PREVIEW_AUTH_SEED_OUTPUT: "fixture-auth-seed.json",
        TEST_STAGE_EXPIRES_AT: "4070908800000",
      }
    : deployEnvironment(synthetic);
  if (!candidateProof || candidateProof.includes("-state-"))
    Object.assign(process.env, {
      BASALT_RELEASE_CANDIDATE: settings.BASALT_RELEASE_CANDIDATE ?? "a".repeat(40),
      BASALT_EXECUTOR_MARKER_POLICY: "fixture-executor-marker-policy.json",
      BASALT_RELEASE_EVIDENCE_DIRECTORY: "fixture-release-evidence",
    });
  if (settings.BASALT_RELEASE_ATTEMPT)
    process.env.BASALT_RELEASE_ATTEMPT = settings.BASALT_RELEASE_ATTEMPT;
  // The release entry gives every stage an attempt id, test stages included.
  if (settlesProof) process.env.BASALT_RELEASE_ATTEMPT = "00000000-0000-4000-8000-000000000001";
  settings.EXECUTOR_E2E_MANUAL_CRON = process.env.NATIVE_STACK_MANUAL_CRON ?? "false";
  phase = "import";
  const [
    { default: actualRoot },
    { evalStack },
    { AlchemyContextLive },
    { provideFreshArtifactStore },
    { layerNonInteractive },
    { Effect, ConfigProvider, Layer, Exit, Cause },
    NodeServices,
    Output,
  ] = await Promise.all([
    load("alchemy.run.ts"),
    import("alchemy/Stack"),
    import("alchemy/AlchemyContext"),
    import("alchemy/Artifacts"),
    import("alchemy/Interaction"),
    import("effect"),
    import("@effect/platform-node/NodeServices"),
    import("alchemy/Output"),
  ]);
  phase = "evaluate";
  const rootContainerProof =
    process.env.NATIVE_STACK_ROOT_CONTAINER_PROOF === "true"
      ? await import("./root-container-plan-proof.mjs")
      : undefined;
  const planSettles = settlesProof ? await import("./plan-settles-proof.mjs") : undefined;
  const inspect = planSettles
    ? (stack) =>
        planSettles.provePlanSettles(stack, (inspectNext) => {
          process.env.BASALT_RELEASE_ATTEMPT = "00000000-0000-4000-8000-000000000002";
          return evalStack(actualRoot, inspectNext, { stage: settings.ALCHEMY_STAGE });
        })
    : (stack) =>
        Effect.sync(() =>
          inventoryDeclarations(Object.values(stack.resources), stack.bindings, Output.isOutput),
        );
  const program = evalStack(
    actualRoot,
    (stack) =>
      Effect.gen(function* () {
        http.assertAllowed();
        return yield* rootContainerProof?.proveRootContainerPlan(stack) ?? inspect(stack);
      }),
    { stage: settings.ALCHEMY_STAGE },
  ).pipe(
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
    const labels = [
      "Invalid native declaration name",
      "Invalid native declaration metadata",
      "Invalid native bindings",
      "Manual cron requires a local E2E Cloud.",
      "Unknown native Worker export kind",
      "Unmatched native workflow export",
      "Invalid native binding contributions",
    ];
    const metadata =
      /Invalid native declaration metadata:(record|resource|props|env|contribution|data|exports|export|binding)-(undefined|object|array|function|string|number|boolean|symbol|bigint)/.exec(
        diagnostic,
      )?.[0];
    throw new Error(metadata ?? labels.find((label) => diagnostic.includes(label)) ?? "evaluation");
  }
  emit(JSON.stringify(exit.value));
} catch (error) {
  // Never forward exception messages, causes, file paths, config, or request details.
  const labels = [
    "Invalid native declaration name",
    "Invalid native declaration metadata",
    "Invalid native bindings",
    "Manual cron requires a local E2E Cloud.",
    "Unknown native Worker export kind",
    "Unmatched native workflow export",
    "Invalid native binding contributions",
  ];
  const safe =
    labels.includes(error?.message) ||
    /^Invalid native declaration metadata:(record|resource|props|env|contribution|data|exports|export|binding)-(undefined|object|array|function|string|number|boolean|symbol|bigint)$/.test(
      error?.message,
    );
  emit(
    JSON.stringify({
      error: `native-stack-${phase}-failed`,
      reason: safe ? error.message : "redacted",
    }),
  );
  process.exitCode = 1;
}
