import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { fileURLToPath } from "node:url";
import { Config, Effect } from "effect";
import { telemetryBindings } from "./src/telemetry/deployment.ts";
import { retain } from "alchemy/RemovalPolicy";
import { adopt } from "alchemy/AdoptPolicy";
import { brand } from "./brand.ts";
import { poolWorker } from "./src/pool/deployment.ts";
import {
  cloudDeployment,
  cloudProviders,
  cloudWorkers,
} from "./.upstream/apps/hosted/cloud/alchemy.run.ts";
import { Api } from "./.upstream/apps/hosted/cloud/src/infrastructure/api-worker.ts";
import { stackState } from "./.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

export default Alchemy.Stack(
  "basalt",
  { providers: cloudProviders, state: stackState },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: brand.zone }).pipe(
      Effect.orDie,
    );
    if (!zone) return yield* Effect.die(new Error(`Cloudflare zone ${brand.zone} is missing`));
    const email = yield* Cloudflare.Email.SendingSubdomain("AuthEmailDomain", {
      zoneId: zone.id,
      name: brand.emailDomain,
    }).pipe(retain());
    const namespaceScript = fileURLToPath(
      new URL("./scripts/ensure-artifacts.ts", import.meta.url),
    );
    const namespace = yield* Command.Exec("AppSourceNamespace", {
      command: "node '" + namespaceScript.replaceAll("'", "'\\''") + "'",
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: yield* Config.Redacted("CLOUDFLARE_API_TOKEN"),
      },
      memo: false,
      timeout: "1 minute",
    });
    yield* cloudDeployment;
    const api = yield* Api;
    const pool = yield* poolWorker;
    const catalog = yield* Cloudflare.Worker("Catalog", {
      main: fileURLToPath(new URL("./src/catalog/worker.ts", import.meta.url)),
      env: {
        GOOGLE_CONNECTOR_READY: yield* Config.String("GOOGLE_CONNECTOR_READY").pipe(Config.withDefault("false")),
        GITHUB_CONNECTOR_READY: yield* Config.String("GITHUB_CONNECTOR_READY").pipe(Config.withDefault("false")),
      },
      workersDev: false,
      compatibility: { date: "2026-09-08" },
    });
    const router = yield* Cloudflare.Worker("Router", {
      main: new URL("./src/router.ts", import.meta.url).pathname,
      // The brand's logo and favicon; every other path reaches the router code.
      assets: fileURLToPath(new URL("./public/", import.meta.url)),
      domain: brand.host,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        TOOLS_SERVICE: api,
        CATALOG_SERVICE: catalog,
        POOL_SERVICE: pool,
        POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
        TELEMETRY_RELAY_KEY: yield* Config.Redacted("TELEMETRY_RELAY_KEY"),
        ...(yield* telemetryBindings),
        SOURCE_NAMESPACE_READY: namespace.hash.pipe(Output.map(() => "eu")),
      },
    });
    return { url: router.url, emailReady: email.enabled };
  }).pipe(adopt(true), Effect.provide(cloudWorkers)),
);
