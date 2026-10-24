import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { fileURLToPath } from "node:url";
import { Config, Effect } from "effect";
import { retain } from "alchemy/RemovalPolicy";
import { adopt } from "alchemy/AdoptPolicy";
import { brand, deployment } from "./brand.ts";
import { poolWorker } from "./src/pool/deployment.ts";
import { previewStageOrigin } from "./scripts/environment.ts";
import {
  cloudDeployment,
  cloudProviders,
  cloudWorkers,
} from "./.upstream/apps/hosted/cloud/alchemy.run.ts";
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
      command: "node '" + namespaceScript.replaceAll("'", "'\\''") + "'",
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
        command: "node '" + seedScript.replaceAll("'", "'\\''") + "'",
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
    const router = yield* Cloudflare.Worker("Router", {
      main: new URL("./src/router.ts", import.meta.url).pathname,
      // The brand's logo and favicon; every other path reaches the router code.
      assets: fileURLToPath(new URL("./public/", import.meta.url)),
      domain: host,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        TOOLS_SERVICE: api,
        POOL_SERVICE: pool,
        POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
        SOURCE_NAMESPACE_READY: namespace.hash.pipe(Output.map(() => "eu")),
      },
    });
    return { url: router.url, emailReady };
  }).pipe(adopt(true), Effect.provide(cloudWorkers)),
);
