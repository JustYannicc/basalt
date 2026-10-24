import { fileURLToPath } from "node:url";
import { connectorWarnings, deployEnvironment } from "./environment.ts";
import { appHosting } from "../brand.ts";
import { run } from "./process.ts";

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Production deployment runs only in GitHub Actions");
}
const environment = deployEnvironment();
if (!environment.SENTRY_DSN) console.warn("SENTRY_DSN is unset; feedback, error reporting and trace export are disabled.");
if (!environment.POSTHOG_PROJECT_KEY) console.warn("POSTHOG_PROJECT_KEY is unset; product analytics are disabled.");
if (environment.SENTRY_DSN && !environment.SENTRY_OTLP_ENDPOINT) console.warn("SENTRY_OTLP_ENDPOINT is unset; trace export is disabled.");
for (const warning of connectorWarnings(environment)) console.warn(warning);
const cloud = fileURLToPath(new URL("../.upstream/apps/hosted/cloud/", import.meta.url));
if (appHosting.enabled) {
  run(
    "bun",
    ["exec", "alchemy", "deploy", "alchemy.app-domains.ts", "--stage", "shared", "--yes"],
    cloud,
    environment,
  );
}
run(
  "bun",
  [
    "exec",
    "alchemy",
    "deploy",
    "../../../../alchemy.run.ts",
    "--stage",
    environment.ALCHEMY_STAGE!,
    "--yes",
  ],
  cloud,
  environment,
);
