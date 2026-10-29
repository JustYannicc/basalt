import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect } from "effect";
import { apiPathsExpression } from "./src/browser-check.ts";
import { telemetryBindings, workerObservability } from "./src/telemetry/deployment.ts";
import { retain } from "alchemy/RemovalPolicy";
import { adopt } from "alchemy/AdoptPolicy";
import { appHosting, brand, deployment } from "./brand.ts";
import { poolWorker } from "./src/pool/deployment.ts";
import { previewStageOrigin } from "./scripts/environment.ts";
import {
  cloudDeployment,
  cloudProviders,
  cloudWorkers,
} from "./.upstream/apps/hosted/cloud/alchemy.run.ts";
import AppPages from "./.upstream/apps/hosted/cloud/src/app-ui.ts";
import { Api } from "./.upstream/apps/hosted/cloud/src/infrastructure/api-worker.ts";
import { stackState } from "./.upstream/apps/hosted/cloud/src/infrastructure/state.ts";
import { previewDatabase } from "./.upstream/apps/hosted/cloud/src/infrastructure/preview-database.ts";

export default Alchemy.Stack(
  "basalt",
  { providers: cloudProviders, state: stackState },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const stage = yield* Stage;
    const previewNumber = /^test-pr-([1-9][0-9]*)$/.exec(stage)?.[1];
    const preview = previewNumber === undefined ? undefined : {
      number: previewNumber,
      domain: yield* Config.NonEmptyString("TEST_STAGE_DOMAIN"),
      sourceNamespace: yield* Config.NonEmptyString("CLOUD_SOURCE_NAMESPACE"),
      databaseName: yield* Config.NonEmptyString("TEST_STAGE_DATABASE"),
    };
    if (preview !== undefined) {
      const expectedNamespace = `basalt-preview-pr-${preview.number}-apps`;
      if (preview.sourceNamespace !== expectedNamespace)
        return yield* Effect.die(new Error("Preview Artifacts namespace does not match its stage."));
      const expectedDatabase = `basalt-preview-pr-${preview.number}`;
      if (preview.databaseName !== expectedDatabase)
        return yield* Effect.die(new Error("Preview PlanetScale database does not match its stage."));
    }
    const zoneName = preview?.domain ?? brand.zone;
    const host = preview === undefined ? brand.host : `app.pr-${preview.number}.${preview.domain}`;
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: zoneName }).pipe(
      Effect.orDie,
    );
    if (!zone) return yield* Effect.die(new Error("Cloudflare zone for this stage is missing"));
    if (preview === undefined) {
      // API, MCP and CLI clients are not browsers, so Browser Integrity Check (1010) would block them.
      // The zone keeps it for everything else. This resource owns the zone's whole configuration-rules
      // phase, which is why previews, sharing one zone, don't create it. Ruleset reads only `zoneId`.
      yield* Cloudflare.Ruleset.Ruleset("ApiBrowserCheckExemption", {
        zone: { zoneId: zone.id } as unknown as Cloudflare.Zone.Zone,
        phase: "http_config_settings",
        description: "Basalt API paths skip Browser Integrity Check",
        rules: [{
          action: "set_config",
          actionParameters: { bic: false },
          expression: apiPathsExpression(host),
          description: "Non-browser API paths on the app host",
          enabled: true,
        }],
      });
    }
    if (preview === undefined && appHosting.enabled) {
      yield* Cloudflare.DNS.Record("AppOriginWildcard", {
        zoneId: zone.id, zoneName: zoneName, name: `*.${appHosting.zone}`,
        type: "AAAA", content: "100::", proxied: true, ttl: "1",
        comment: "Routes private app origins through the app host dispatcher",
      }).pipe(adopt(false));
      // A route runs before a Custom Domain origin. Exclude only configured product hosts.
      for (const productHost of appHosting.bypassHosts) {
        yield* Cloudflare.Workers.WorkerRoute(`AppHostBypass-${productHost}`, {
          zoneId: zone.id, pattern: `${productHost}/*`,
        }).pipe(adopt(false));
      }
    }
    const emailReady = preview === undefined
      ? (yield* Cloudflare.Email.SendingSubdomain("AuthEmailDomain", {
          zoneId: zone.id,
          name: brand.emailDomain,
        }).pipe(retain())).enabled
      : false;
    const namespaceScript = fileURLToPath(
      new URL("./scripts/ensure-artifacts.ts", import.meta.url),
    );
    const namespace = yield* Command.Exec("AppSourceNamespace", {
      // Alchemy splits the command on whitespace without a shell, so quotes would reach node literally.
      command: `node ${basename(namespaceScript)}`,
      cwd: dirname(namespaceScript),
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: yield* Config.Redacted("CLOUDFLARE_API_TOKEN"),
        CLOUD_SOURCE_NAMESPACE: preview?.sourceNamespace ?? deployment.sourceNamespace,
      },
      memo: false,
      timeout: "1 minute",
    });
    yield* cloudDeployment;
    if (preview !== undefined) {
      const migration = yield* previewDatabase({
        name: stage,
        slug: `pr-${preview.number}`,
        domain: preview.domain,
        origin: previewStageOrigin(`pr-${preview.number}`, preview.domain, false),
      });
      const seedScript = fileURLToPath(
        new URL("./scripts/preview-auth/seed.ts", import.meta.url),
      );
      yield* Command.Exec("PreviewAuthSeed", {
        command: `node ${basename(seedScript)}`,
        cwd: dirname(seedScript),
        env: {
          ALCHEMY_STAGE: stage,
          TEST_STAGE_DOMAIN: preview.domain,
          BETTER_AUTH_URL: previewStageOrigin(`pr-${preview.number}`, preview.domain),
          DATABASE_URL: migration.migrationUrl,
          TEST_STAGE_DATABASE_BRANCH: migration.branchName,
          TEST_STAGE_DATABASE_NAME: migration.databaseName,
          TEST_STAGE_DATABASE_USERNAME: migration.username,
          PREVIEW_SMOKE_EMAIL: yield* Config.String("PREVIEW_SMOKE_EMAIL"),
          PREVIEW_SMOKE_PASSWORD: yield* Config.Redacted("PREVIEW_SMOKE_PASSWORD"),
          PREVIEW_AUTH_SEED_OUTPUT: yield* Config.NonEmptyString("PREVIEW_AUTH_SEED_OUTPUT"),
        },
        memo: false,
        timeout: "2 minutes",
      });
    }
    const api = yield* Api;
    const pool = yield* poolWorker;
    const catalog = yield* Cloudflare.Worker("Catalog", {
      main: fileURLToPath(new URL("./src/catalog/worker.ts", import.meta.url)),
      env: {
        ZENDESK_MARKETPLACE_ORGANIZATION_ID: yield* Config.String("ZENDESK_MARKETPLACE_ORGANIZATION_ID").pipe(Config.withDefault("")),
        ZENDESK_MARKETPLACE_APP_ID: yield* Config.String("ZENDESK_MARKETPLACE_APP_ID").pipe(Config.withDefault("")),
      },
      workersDev: false,
      compatibility: { date: "2026-09-08" },
      observability: workerObservability,
    });
    // The public home and legal pages at the zone's apex. Previews share the zone, so only
    // production owns its apex.
    if (preview === undefined)
      // Upstream's Command.Build already owns "Site". Alchemy reuses logical IDs across resource types.
      yield* Cloudflare.Worker("PublicSite", {
        main: fileURLToPath(new URL("./src/site/worker.ts", import.meta.url)),
        // Only the brand's logo, fonts and favicon come from assets. The router's own pages in
        // public/, such as /setup and /share, must never answer on the apex.
        assets: {
          directory: fileURLToPath(new URL("./public/", import.meta.url)),
          runWorkerFirst: ["/*", "!/brand/*", "!/favicon.ico"],
        },
        domain: { name: brand.zone, redirects: [`www.${brand.zone}`] },
        workersDev: false,
        compatibility: { date: "2026-09-08" },
        observability: workerObservability,
      });
    const router = yield* Cloudflare.Worker("Router", {
      main: new URL("./src/router.ts", import.meta.url).pathname,
      // The brand's logo and favicon; every other path reaches the router code.
      assets: { directory: fileURLToPath(new URL("./public/", import.meta.url)), runWorkerFirst: true },
      domain: host,
      // Cloudflare rejects infix host wildcards. More specific product-host bypasses protect their existing origins.
      ...(preview === undefined && appHosting.enabled ? { routes: [{ pattern: `*.${appHosting.zone}/*` }] } : {}),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      observability: workerObservability,
      env: {
        DASHBOARD_HOST: host,
        TOOLS_SERVICE: api,
        ...(preview === undefined && appHosting.enabled ? { APP_UI_SERVICE: yield* AppPages } : {}),
        CATALOG_SERVICE: catalog,
        POOL_SERVICE: pool,
        POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
        TELEMETRY_RELAY_KEY: yield* Config.Redacted("TELEMETRY_RELAY_KEY"),
        ...(yield* telemetryBindings),
        SOURCE_NAMESPACE_READY: namespace.hash.pipe(Output.map(() => "eu")),
      },
    });
    return { url: router.url, emailReady };
  }).pipe(adopt(true), Effect.provide(cloudWorkers)),
);
