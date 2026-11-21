import { provisionPublicSiteWaitlist } from "./scripts/release-barrier/public-site-waitlist.ts";
import { provisionVaultAttachments } from "./scripts/release-barrier/vault-attachments.ts";
import { productionOpsRelease } from "./.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Planetscale from "alchemy/Planetscale";
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
import { verifyRuntimeDatabaseBudget } from "./src/pool/database-budget.ts";
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
import { releaseStackState } from "./scripts/release-barrier/read-only-state.ts";
import { stackNameForStage } from "./scripts/release-barrier/release-stage.ts";
import { stageNames, subjectFromStage } from "./scripts/preview/subject.ts";
import { previewDatabase } from "./.upstream/apps/hosted/cloud/src/infrastructure/preview-database.ts";

export default Alchemy.Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  { providers: cloudProviders, state: releaseStackState(stackState) },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const stage = yield* Stage;
    // The stack name is fixed before evaluation from ALCHEMY_STAGE; a differing --stage would land elsewhere.
    if (stackNameForStage(stage) !== stackNameForStage(process.env.ALCHEMY_STAGE))
      return yield* Effect.die(
        new Error("The deploy stage and ALCHEMY_STAGE name different stacks."),
      );
    // PR previews and release rehearsals are the disposable stages; every other stage is production.
    const previewSubject = subjectFromStage(stage);
    const preview =
      previewSubject === undefined
        ? undefined
        : {
            names: stageNames(previewSubject),
            domain: yield* Config.NonEmptyString("TEST_STAGE_DOMAIN"),
            sourceNamespace: yield* Config.NonEmptyString("CLOUD_SOURCE_NAMESPACE"),
            databaseName: yield* Config.NonEmptyString("TEST_STAGE_DATABASE"),
          };
    if (preview !== undefined) {
      if (preview.sourceNamespace !== preview.names.sourceNamespace)
        return yield* Effect.die(
          new Error("Preview Artifacts namespace does not match its stage."),
        );
      if (preview.databaseName !== preview.names.databaseName)
        return yield* Effect.die(
          new Error("Preview PlanetScale database does not match its stage."),
        );
    }
    const zoneName = preview?.domain ?? brand.zone;
    const host = preview === undefined ? brand.host : `app.${preview.names.slug}.${preview.domain}`;
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
        rules: [
          {
            action: "set_config",
            actionParameters: { bic: false },
            expression: apiPathsExpression(host),
            description: "Non-browser API paths on the app host",
            enabled: true,
          },
        ],
      });
    }
    if (preview === undefined && appHosting.enabled) {
      yield* Cloudflare.DNS.Record("AppOriginWildcard", {
        zoneId: zone.id,
        zoneName: zoneName,
        name: `*.${appHosting.zone}`,
        type: "AAAA",
        content: "100::",
        proxied: true,
        ttl: "1",
        comment: "Routes private app origins through the app host dispatcher",
      }).pipe(adopt(false));
      // A route runs before a Custom Domain origin. Exclude only configured product hosts.
      for (const productHost of appHosting.bypassHosts) {
        yield* Cloudflare.Workers.WorkerRoute(`AppHostBypass-${productHost}`, {
          zoneId: zone.id,
          pattern: `${productHost}/*`,
        }).pipe(adopt(false));
      }
    }
    const emailReady =
      preview === undefined
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
      // The Router reads this command's outcome. A plan cannot know the outcome of a command that
      // runs on every plan, so the Router would plan as an update forever. Keyed on what the
      // command reads, it runs when that changes. The brand file is not in the key: the script
      // takes only its namespace name from it, and that name is passed above. A test stage builds
      // under its own brand, which would otherwise change the key between a deploy and a plan.
      memo: { include: ["ensure-artifacts.ts", "artifacts-http-failure.ts"] },
      timeout: "1 minute",
    });
    yield* cloudDeployment;
    let previewMigration: Effect.Success<ReturnType<typeof previewDatabase>> | undefined;
    if (preview !== undefined) {
      previewMigration = yield* previewDatabase({
        name: stage,
        slug: preview.names.slug,
        domain: preview.domain,
        origin: previewStageOrigin(preview.names.slug, preview.domain, false),
      });
    }
    const api = yield* Api;
    const pool = yield* poolWorker;
    // The shared cluster's runtime budget is production's. `.ref` reads deployed state, which a
    // disposable stage's first deploy does not have; its own database carries the preview pool cap.
    if (preview === undefined) {
      const runtimeRole = yield* Planetscale.PostgresRole.ref("RuntimeRole");
      const migrationRole = yield* Planetscale.PostgresRole.ref("MigrationRole");
      yield* verifyRuntimeDatabaseBudget("ToolsBackendBudget", {
        adminUrl: migrationRole.connectionUrl,
        runtimeLogin: runtimeRole.username,
        databases: ["postgres"],
        deployment: api.hash,
        candidate: productionOpsRelease,
      });
    }
    const catalog = yield* Cloudflare.Worker("Catalog", {
      main: fileURLToPath(new URL("./src/catalog/worker.ts", import.meta.url)),
      env: {
        ZENDESK_MARKETPLACE_ORGANIZATION_ID: yield* Config.String(
          "ZENDESK_MARKETPLACE_ORGANIZATION_ID",
        ).pipe(Config.withDefault("")),
        ZENDESK_MARKETPLACE_APP_ID: yield* Config.String("ZENDESK_MARKETPLACE_APP_ID").pipe(
          Config.withDefault(""),
        ),
      },
      workersDev: false,
      compatibility: { date: "2026-09-08" },
      observability: workerObservability,
    });
    // Vault attachment bytes. Like the waiting list, a separate release provisions it before any
    // Worker binds it; previews bind no retained bucket.
    if (preview === undefined) yield* provisionVaultAttachments;
    // The public home and legal pages at the zone's apex. Previews share the zone, so only
    // production owns its apex.
    if (preview === undefined) {
      // A separate release provisions the database before this binding ships, so admission
      // precedes creation.
      // Binding the resource this one declaration yields keeps the stack evaluable before the
      // database is recorded, and gives the barrier the edge it needs to refuse create-and-bind.
      // The exported state reference resolves from recorded state, so it only suits a later binding.
      const waitlist = yield* provisionPublicSiteWaitlist;
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
        env: {
          WAITLIST: waitlist,
          // Rate limit namespace IDs are account-wide; no other Basalt Worker uses 7101.
          WAITLIST_LIMIT: Cloudflare.RateLimit("WAITLIST_LIMIT", {
            namespaceId: 7101,
            simple: { limit: 5, period: 60 },
          }),
        },
      });
    }
    const router = yield* Cloudflare.Worker("Router", {
      main: new URL("./src/router.ts", import.meta.url).pathname,
      // The brand's logo and favicon; every other path reaches the router code.
      assets: {
        directory: fileURLToPath(new URL("./public/", import.meta.url)),
        runWorkerFirst: true,
      },
      domain: host,
      // Cloudflare rejects infix host wildcards. More specific product-host bypasses protect their existing origins.
      ...(preview === undefined && appHosting.enabled
        ? { routes: [{ pattern: `*.${appHosting.zone}/*` }] }
        : {}),
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
    if (preview !== undefined && previewMigration !== undefined) {
      const seedScript = fileURLToPath(new URL("./scripts/preview-auth/seed.ts", import.meta.url));
      yield* Command.Exec("PreviewAuthSeed", {
        command: `node ${basename(seedScript)}`,
        cwd: dirname(seedScript),
        env: {
          ALCHEMY_STAGE: stage,
          TEST_STAGE_DOMAIN: preview.domain,
          BETTER_AUTH_URL: previewStageOrigin(preview.names.slug, preview.domain),
          DATABASE_URL: previewMigration.migrationUrl,
          TEST_STAGE_DATABASE_BRANCH: previewMigration.branchName,
          TEST_STAGE_DATABASE_NAME: previewMigration.databaseName,
          TEST_STAGE_DATABASE_USERNAME: previewMigration.username,
          PREVIEW_SMOKE_EMAIL: yield* Config.String("PREVIEW_SMOKE_EMAIL"),
          PREVIEW_SMOKE_PASSWORD: yield* Config.Redacted("PREVIEW_SMOKE_PASSWORD"),
          PREVIEW_AUTH_SEED_OUTPUT: yield* Config.NonEmptyString("PREVIEW_AUTH_SEED_OUTPUT"),
          // Alchemy orders work only by inputs: the seed signs in through these, so it waits for them.
          PREVIEW_STACK_DEPLOYED: Output.all(router.hash, api.hash, pool.hash).pipe(
            Output.map((hashes) => hashes.join(":")),
          ),
        },
        memo: false,
        timeout: "5 minutes",
      });
    }
    return { url: router.url, emailReady };
  }).pipe(adopt(true), Effect.provide(cloudWorkers)),
);
