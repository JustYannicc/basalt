import { fileURLToPath } from "node:url";
import { connectorWarnings, deployEnvironment } from "./environment.ts";
import { appHosting } from "../brand.ts";
import { deployInPhases } from "./release-phases/deploy.ts";
import { releaseTarget } from "./release-barrier/release-stage.ts";
import { rehearsalReleaseEnvironment } from "./release-preview/rehearsal-environment.ts";

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Production deployment runs only in GitHub Actions");
}
// A rehearsal releases its disposable stage with the same phases; an unknown stage refuses here.
const environment = releaseTarget().rehearsal
  ? rehearsalReleaseEnvironment(process.env)
  : deployEnvironment();
if (!environment.SENTRY_DSN)
  console.warn("SENTRY_DSN is unset; feedback, error reporting and trace export are disabled.");
if (!environment.POSTHOG_PROJECT_KEY)
  console.warn("POSTHOG_PROJECT_KEY is unset; product analytics are disabled.");
if (environment.SENTRY_DSN && !environment.SENTRY_OTLP_ENDPOINT)
  console.warn("SENTRY_OTLP_ENDPOINT is unset; trace export is disabled.");
for (const warning of connectorWarnings(environment)) console.warn(warning);
const cloud = fileURLToPath(new URL("../.upstream/apps/hosted/cloud/", import.meta.url));
await deployInPhases({
  cloud,
  environment,
  sharedFoundation: appHosting.enabled && appHosting.scheme === "nested",
  recovery: process.argv.slice(2),
});
