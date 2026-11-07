import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deployEnvironment, requiredSecrets } from "./environment.ts";
import { run } from "./process.ts";
import { checkMcpRuntimeBundle } from "./mcp-runtime-bundle.ts";

const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
const cloud = fileURLToPath(new URL("../.upstream/apps/hosted/cloud/", import.meta.url));
// Use upstream's credential-free bundling check with this stack's configuration.
const credentials = Object.fromEntries(requiredSecrets.map((name) => [name, "0".repeat(64)]));
credentials.CLOUDFLARE_ACCOUNT_ID = "0".repeat(32);
credentials.BASALT_RELEASE_ATTEMPT = "00000000-0000-4000-8000-000000000001";
// Budget the fully enabled telemetry path with synthetic public capture settings.
credentials.SENTRY_DSN = "https://fixture_public_key@o0.ingest.de.sentry.io/1";
credentials.SENTRY_OTLP_ENDPOINT =
  "https://o0.ingest.de.sentry.io/api/1/integration/otlp/v1/traces";
credentials.POSTHOG_PROJECT_KEY = "synthetic_project_key";
credentials.POSTHOG_HOST = "https://us.i.posthog.com";
const configuration = deployEnvironment(credentials);
const source = readFileSync(`${cloud}/scripts/worker-sizes.ts`, "utf8");
const pattern = /const production: Target = \{[\s\S]*?\n\};/;
if ((source.match(new RegExp(pattern.source, "g")) ?? []).length !== 1) {
  throw new Error("Upstream worker build contract changed");
}
writeFileSync(
  `${cloud}/scripts/basalt-worker-sizes.ts`,
  source
    .replace(
      "yield* AppPages;",
      'if (yield* Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(Config.option, Effect.map(Option.isSome))) yield* AppPages;',
    )
    .replace(
      pattern,
      `const production: Target = ${JSON.stringify({ stage: configuration.ALCHEMY_STAGE, configuration })};`,
    ),
);
run("bun", ["packages/sdk/scripts/check-storage-versions.ts"], upstream);
run("bun", ["scripts/basalt-worker-sizes.ts"], cloud, {
  ...process.env,
  BASALT_RELEASE_ATTEMPT: credentials.BASALT_RELEASE_ATTEMPT,
});
checkMcpRuntimeBundle();
