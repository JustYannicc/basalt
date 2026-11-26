/**
 * Real Alchemy plans for the plan check: real Cloudflare resources and providers, Alchemy's own
 * `Plan.make`, and an in-memory State seeded with production-shaped rows. Whatever a provider reads
 * from Cloudflare while it diffs is served by a local HTTP server from the shapes recorded in
 * production (container application read, 2026-11-18); any other request fails the plan.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { DockerLive } from "alchemy/Docker/Docker";
import * as Apply from "alchemy/Apply";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { retain } from "alchemy/RemovalPolicy";
import { renamedFrom } from "alchemy/Rename";
import { Stack, evalStack } from "alchemy/Stack";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State, StateStoreError } from "alchemy/State/State";
import type { ResourceState } from "alchemy/State/ResourceState";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, type Exit, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { poolObservationTokenProps } from "../../../src/pool/fleet-observation.ts";
import { poolDatabaseReadiness } from "../../../src/pool/database.ts";
import { poolWorkerAcceptance } from "../../../src/pool/database-budget.ts";
import { databasePoolBudget } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-budget.ts";

export const accountId = "0".repeat(32);
export const applicationId = "11111111-1111-4111-8111-111111111111";
export const buildContext = fileURLToPath(new URL("./plan-context/", import.meta.url));
export const pinnedImage = `registry.cloudflare.com/${accountId}/pool-root@sha256:${"e".repeat(64)}`;
const routeGatewayImage = `registry.cloudflare.com/${accountId}/route-gateway@sha256:${"d".repeat(64)}`;
const entry = fileURLToPath(new URL("./plan-worker.ts", import.meta.url));
const scope = { stack: "basalt", stage: "production" };

export interface Declaration {
  /** How the root container names its image: the pin, or a build context. */
  container?: { image: string } | { context: string };
  containerInstanceType?: string;
  /** PoolWorker's ledger class binding; `undefined` drops the binding from the declaration. */
  ledger?: { className: string; transferredFrom?: string } | undefined;
  bucketJurisdiction?: "eu" | "default";
  bucketStorageClass?: "Standard" | "InfrequentAccess";
  /** Declares the retained scratch bucket under a new id that claims its old row. */
  renamedScratch?: boolean;
  /** Declares the retained scratch bucket under its own id, in this jurisdiction. */
  scratchJurisdiction?: "eu" | "default";
  /** Adds a binding that State has never recorded, optionally declared as moved from a Worker. */
  newClass?: boolean | { transferredFrom: string };
  /** Binds the two fleet classes (PoolRuntimeBlue, PoolRuntimeGreen), as the cutover declares them. */
  fleetClasses?: boolean;
  /**
   * Binds the route gateway's container on PoolWorker, as `src/route/deployment.ts` declares it;
   * an object changes its instance type.
   */
  routeGateway?: boolean | { instanceType: string };
  /** Declares the retained Secrets Store; when false its seeded row has no declaration. */
  observationStore?: boolean;
  /** Declares the release command; when false its seeded row has no declaration. */
  databaseCommand?: boolean;
  /** Binds the vault bucket to PoolWorker; when false the binding is dropped. */
  vaultBinding?: boolean;
  /**
   * PoolWorker reads the pool database command's outcome, as production's does
   * (`POOL_DATABASE_READY`): a setting the plan cannot know while that command runs.
   */
  poolWorkerWaitsOnCommand?: boolean;
  /**
   * Declares the pool database command as the stack does (`poolDatabaseReadiness`), with the real
   * pool size command, and PoolWorker reading its readiness as production's does. A tools
   * migration stand-in reads `toolsSource`, as the real one reads the hosted sources. PoolWorker's
   * readiness wait and acceptance are the stack's own (`poolWorkerAcceptance`).
   */
  poolDatabase?: { toolsSource?: string; budgetDatabase?: string };
  /** Adds plain env values to ArtifactsCredentials, which State never recorded. */
  credentialsEnv?: Record<string, string>;
  /** Binds a second class on ArtifactsCredentials, which State never recorded. */
  credentialsClass?: string;
  /**
   * What ArtifactsCredentials holds besides its class, in production's forms: the tools Worker it
   * calls, a secret, a redacted value that carries the release's version, and a JSON value.
   */
  credentials?: {
    /** Its entry file; by default the fixture's Worker entry. */
    main?: string;
    secret?: string;
    version?: string;
    /** The credential inside the redacted value that also carries the version. */
    token?: string;
    /** Declares that value as plain text instead of a secret. */
    telemetryPlain?: boolean;
    mode?: string;
    /** The Worker it calls: the tools Worker, or another one under the same name. */
    calls?: "Api" | "Catalog";
    /** The class its `Coordinator` binding names; by default the recorded one. */
    className?: string;
    /** The host of the model database connection it reads; another host updates that connection. */
    databaseHost?: string;
    /**
     * Stack code binds its own row under the database entry's name, with a wire entry of another
     * name; `"with local copy"` adds local development's copy of the connection's origin to it.
     */
    ownDatabaseRow?: true | "with local copy";
    /** The Worker it calls binds the store's class, as production's tools Worker does: a cycle. */
    calledBindsStore?: boolean;
  };
  /** Declares the provider observation token as production does, under this fixture's account. */
  observationToken?: boolean;
}

/** An application the fake account holds besides the root: its identity, as a test names it. */
export interface FakeApplication {
  readonly id: string;
  readonly name: string;
  readonly namespaceId: string;
}
/** The route gateway's application, as the fake API creates it. */
export const routeGatewayApplication: FakeApplication = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "basalt-production-route-gateway",
  namespaceId: "namespace-route-gateway",
};

/**
 * The recorded production body of the root application read, with synthetic identifiers; another
 * application is served in the same recorded shape under its own identity.
 */
const applicationBody = (image: string, as?: FakeApplication) => ({
  success: true,
  result: {
    id: as?.id ?? applicationId,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    account_id: accountId,
    name: as?.name ?? "basalt-production-poolcontainer",
    version: 57,
    scheduling_policy: "default",
    instances: 1,
    max_instances: 1,
    configuration: {
      image,
      vcpu: 0.25,
      memory: "1GiB",
      memory_mib: 1024,
      disk: { size_mb: 4000, size: "4GB" },
      environment_variables: [{ name: "POOL_SETTING", value: "synthetic" }],
      network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
      command: [],
      entrypoint: [],
      runtime: "firecracker",
      observability: { logs: { enabled: true } },
    },
    constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
    durable_objects: { namespace_id: as?.namespaceId ?? "namespace-pool-container" },
    health: {
      errors: [],
      instances: {
        active: 1,
        assigned: 0,
        healthy: 0,
        stopped: 0,
        failed: 0,
        scheduling: 0,
        starting: 0,
      },
    },
    network: { bandwidth_limit_mbps: 250 },
  },
  messages: [],
  errors: [],
});

/** The recorded production body of a Worker settings read (2026-11-18), with synthetic names. */
const settingsBody = (bindings: readonly object[], tags: readonly string[]) => ({
  result: {
    placement: {},
    compatibility_date: "2026-09-08",
    compatibility_flags: ["nodejs_compat", "new_module_registry"],
    usage_model: "standard",
    tags,
    tail_consumers: [],
    logpush: false,
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: false, persist: true, head_sampling_rate: 1 },
    },
    annotations: { "workers/triggered_by": "version_upload" },
    bindings,
  },
  success: true,
  errors: [],
  messages: [],
});
const stackTags = (id: string) => [
  "alchemy:stack:basalt",
  "alchemy:stage:production",
  `alchemy:id:${id}`,
];
const recordedSettings: Record<string, { tags: readonly string[]; bindings: readonly object[] }> = {
  "basalt-production-api": { tags: stackTags("Api"), bindings: [] },
  "basalt-production-catalog": { tags: stackTags("Catalog"), bindings: [] },
  "basalt-production-artifactscredentials": {
    tags: stackTags("ArtifactsCredentials"),
    bindings: [
      {
        class_name: "ArtifactsTokenCoordinator",
        name: "Coordinator",
        namespace_id: "namespace-coordinator",
        type: "durable_object_namespace",
      },
    ],
  },
};
/**
 * PoolWorker's settings as production answers them (recorded 2026-11-18): untagged migrations,
 * the class map tag naming only PoolContainer, one local and one cross-script class binding.
 */
const poolWorkerSettings = {
  tags: [...stackTags("PoolWorker"), "alchemy:dos:PoolContainer"],
  bindings: [
    { name: "POOL_MODE", text: "synthetic", type: "plain_text" },
    {
      class_name: "ArtifactsTokenCoordinator",
      name: "BulkUsageImport",
      namespace_id: "namespace-coordinator",
      script_name: "basalt-production-artifactscredentials",
      type: "durable_object_namespace",
    },
    { name: "POOL_MANAGEMENT_KEY", type: "secret_text" },
    {
      class_name: "PoolContainer",
      name: "PoolContainer",
      namespace_id: "namespace-pool-container",
      type: "durable_object_namespace",
    },
  ],
};

/** The fake Cloudflare API the plans talk to; a test may serve the same applications to its own reads. */
export async function cloudflare(
  context: TestContext,
  shadow: boolean,
  containers: { applications: Map<string, FakeApplication>; acceptCreates: boolean },
) {
  const settingsByScript = shadow
    ? { ...recordedSettings, "basalt-production-poolworker": poolWorkerSettings }
    : recordedSettings;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    const application = `/accounts/${accountId}/containers/applications/${applicationId}`;
    const list = `/accounts/${accountId}/containers/applications`;
    const held = request.url?.startsWith(`${list}/`)
      ? containers.applications.get(request.url.slice(list.length + 1))
      : undefined;
    if (
      ((request.method === "GET" || (shadow && request.method === "PATCH")) &&
        request.url === application) ||
      (request.method === "GET" && held)
    ) {
      response.end(JSON.stringify(applicationBody(pinnedImage, held)));
      return;
    }
    // The list as recorded (result_info is an empty object). The root is not in it: what a
    // provider sees for a row State lost. Applications a test created or seeded are.
    if (request.method === "GET" && request.url === list) {
      response.end(
        JSON.stringify({
          success: true,
          result: [...containers.applications.values()].map(
            (held) => applicationBody(pinnedImage, held).result,
          ),
          messages: [],
          errors: [],
          result_info: {},
        }),
      );
      return;
    }
    // Only the route gateway is ever created here; the account then holds it as recorded.
    if (request.method === "POST" && request.url === list && containers.acceptCreates) {
      containers.applications.set(routeGatewayApplication.id, routeGatewayApplication);
      response.end(JSON.stringify(applicationBody(pinnedImage, routeGatewayApplication)));
      return;
    }
    const settings = new RegExp(`^/accounts/${accountId}/workers/scripts/([a-z-]+)/settings$`, "u")
      .exec(request.url ?? "")
      ?.at(1);
    const recorded = settings ? settingsByScript[settings] : undefined;
    if (request.method === "GET" && recorded) {
      response.end(JSON.stringify(settingsBody(recorded.bindings, recorded.tags)));
      return;
    }
    // Planning is read-only and reads nothing else; an unexpected request must fail the plan.
    response.statusCode = request.method === "GET" ? 404 : 405;
    response.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: `no recorded shape for ${request.method}` }],
        messages: [],
        result: null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

/**
 * Runs no process: records each command the apply would run, in order, and answers as a command
 * that succeeded. Everything else about the command is Alchemy's own provider.
 */
const recordingExecutor = (runs: string[]) =>
  Layer.succeed(Command.CommandExecutor, {
    spawn: () => Effect.die(new Error("the plan fixture spawns no process")),
    run: (props) =>
      Effect.sync(() => {
        runs.push(props.command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  } as Command.CommandExecutor["Service"]);

const providers = (base: string, commandRuns?: string[]) =>
  Layer.effect(
    Cloudflare.Providers,
    Provider.collection([
      Cloudflare.Workers.Worker,
      Cloudflare.Containers.ContainerPlatform,
      Cloudflare.R2.Bucket,
      Cloudflare.Hyperdrive.Connection,
      Cloudflare.D1.Database,
      Cloudflare.SecretsStore.Store,
      Cloudflare.ApiToken.AccountApiToken,
      Command.Exec,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Cloudflare.Workers.WorkerProvider(),
        Cloudflare.Containers.ContainerProvider(),
        Cloudflare.R2.BucketProvider(),
        Cloudflare.Hyperdrive.ConnectionProvider(),
        Cloudflare.D1.DatabaseProvider(),
        Cloudflare.SecretsStore.SecretsStoreProvider(),
        Cloudflare.ApiToken.AccountApiTokenProvider(),
        commandRuns
          ? Command.ExecProvider().pipe(Layer.provide(recordingExecutor(commandRuns)))
          : Command.providers(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          Credentials,
          Effect.succeed(apiTokenCredentials({ apiToken: "synthetic", apiBaseUrl: base })),
        ),
        Layer.succeed(
          Cloudflare.CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken" as const,
            accountId,
            apiToken: Redacted.make("synthetic"),
            source: { type: "env" as const },
          }),
        ),
        FetchHttpClient.layer,
      ),
    ),
    // Planning never reaches the daemon; the provider only needs the service to exist.
    Layer.provide(DockerLive),
  );

const modelDatabaseOrigin = (host = "model-database.invalid") => ({
  scheme: "postgres" as const,
  host,
  port: 5432,
  database: "pool",
  user: "pool",
  password: Redacted.make("synthetic-database-password"),
});
const modelDatabaseId = "4".repeat(32);

const service = {
  main: entry,
  workersDev: false,
  compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
};

const program = (declared: Declaration) =>
  Effect.gen(function* () {
    const vault = yield* Cloudflare.R2.Bucket("VaultAttachments", {
      jurisdiction: declared.bucketJurisdiction ?? "eu",
      storageClass: declared.bucketStorageClass ?? "Standard",
    }).pipe(retain());
    const waitlist = yield* Cloudflare.D1.Database("PublicSiteWaitlist", {
      name: "public-site-waitlist",
      jurisdiction: "eu",
    }).pipe(retain());
    if (declared.renamedScratch)
      yield* Cloudflare.R2.Bucket("ScratchArchive", { jurisdiction: "eu" }).pipe(
        retain(),
        renamedFrom("ScratchRecords"),
      );
    if (declared.scratchJurisdiction)
      yield* Cloudflare.R2.Bucket("ScratchRecords", {
        jurisdiction: declared.scratchJurisdiction,
      }).pipe(retain());
    if (declared.observationStore !== false)
      yield* Cloudflare.SecretsStore.Store("PoolObservationSecrets", {}).pipe(retain());
    const databaseCommand =
      declared.databaseCommand !== false && !declared.poolDatabase
        ? yield* Command.Exec("PoolDatabase", { command: "node --version", memo: false })
        : undefined;
    const poolDatabaseReady = declared.poolDatabase
      ? yield* poolDatabaseCommands(declared.poolDatabase)
      : undefined;
    const called = declared.credentials
      ? {
          Api: yield* Cloudflare.Worker("Api", service),
          Catalog: yield* Cloudflare.Worker("Catalog", service),
        }[declared.credentials.calls ?? "Api"]
      : undefined;
    // The model database connection, as the bulk-import store binds it in production.
    const modelDatabase = declared.credentials
      ? yield* Cloudflare.Hyperdrive.Connection("PoolModelDatabaseConnection", {
          origin: modelDatabaseOrigin(declared.credentials.databaseHost),
        })
      : undefined;
    // Declared as main declared it until production's first plan showed State never held it.
    if (declared.observationToken)
      yield* Cloudflare.ApiToken.AccountApiToken(
        "PoolProviderObservationToken",
        poolObservationTokenProps(accountId, scope.stage),
      ).pipe(retain());
    const credentials = yield* Cloudflare.Worker("ArtifactsCredentials", {
      main: declared.credentials?.main ?? entry,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        Coordinator: Cloudflare.DurableObject("ArtifactsTokenCoordinator", {
          className: declared.credentials?.className ?? "ArtifactsTokenCoordinator",
        }),
        ...(declared.credentials
          ? {
              TOOLS_SERVICE: called,
              POOL_AUTH_DATABASE: modelDatabase,
              // A resource whose binding carries more than its stable identity.
              VAULT: vault,
              POOL_APP_SIGNING_KEY: Redacted.make(
                declared.credentials.secret ?? "synthetic-signing-secret",
              ),
              EXECUTOR_TELEMETRY: ((text: string) =>
                declared.credentials?.telemetryPlain ? text : Redacted.make(text))(
                JSON.stringify({
                  version: declared.credentials.version ?? "1",
                  traces: { headers: { authorization: declared.credentials.token ?? "token-a" } },
                }),
              ),
              POOL_MODE: { mode: declared.credentials.mode ?? "a" },
            }
          : {}),
        ...(declared.credentialsClass
          ? {
              Second: Cloudflare.DurableObject(declared.credentialsClass, {
                className: declared.credentialsClass,
              }),
            }
          : {}),
        ...declared.credentialsEnv,
      },
    });
    if (declared.credentials?.ownDatabaseRow && modelDatabase)
      yield* credentials.bind("POOL_AUTH_DATABASE", {
        bindings: [{ type: "hyperdrive", name: "MODEL_DB", id: modelDatabase.hyperdriveId }],
        ...(declared.credentials.ownDatabaseRow === "with local copy"
          ? { hyperdrives: Cloudflare.Hyperdrive.getHyperdriveDevOrigin(modelDatabase) }
          : {}),
      } as never);
    if (declared.credentials?.calledBindsStore && called)
      yield* called.bind("BulkStore", {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "BulkStore",
            className: "ArtifactsTokenCoordinator",
            scriptName: credentials.workerName,
          },
        ],
      } as never);
    const image = Cloudflare.Container("PoolContainer", {
      ...(declared.container ?? { image: pinnedImage }),
      className: "PoolContainer",
      schedulingPolicy: "default",
      instanceType: declared.containerInstanceType ?? "basic",
      maxInstances: 1,
      observability: { logs: { enabled: true } },
    } as never);
    const ledger = "ledger" in declared ? declared.ledger : { className: "PoolLedger" };
    const worker = yield* Cloudflare.Worker("PoolWorker", {
      main: entry,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        PoolContainer: image,
        ...(declared.routeGateway
          ? {
              RouteGateway: Cloudflare.Container("RouteGateway", {
                name: "basalt-production-route-gateway",
                image: routeGatewayImage,
                className: "RouteGateway",
                instanceType:
                  typeof declared.routeGateway === "object"
                    ? declared.routeGateway.instanceType
                    : "lite",
                maxInstances: 20,
                schedulingPolicy: "default",
                observability: { logs: { enabled: true } },
              } as never),
            }
          : {}),
        ...(ledger ? { PoolLedger: Cloudflare.DurableObject("PoolLedger", ledger) } : {}),
        ...(declared.fleetClasses
          ? {
              PoolRuntimeBlue: Cloudflare.DurableObject("PoolRuntimeBlue", {
                className: "PoolRuntimeBlue",
              }),
              PoolRuntimeGreen: Cloudflare.DurableObject("PoolRuntimeGreen", {
                className: "PoolRuntimeGreen",
              }),
            }
          : {}),
        ...(declared.newClass
          ? {
              PoolRuntimeBlue: Cloudflare.DurableObject("PoolRuntimeBlue", {
                className: "PoolRuntimeBlue",
                ...(typeof declared.newClass === "object" ? declared.newClass : {}),
              }),
            }
          : {}),
        BulkUsageImport: Cloudflare.DurableObject("ArtifactsTokenCoordinator", {
          className: "ArtifactsTokenCoordinator",
          scriptName: credentials.workerName,
        }),
        ...(declared.vaultBinding === false ? {} : { VAULT: vault }),
        WAITLIST: waitlist,
        POOL_MANAGEMENT_KEY: Redacted.make("synthetic-management-secret"),
        ...(declared.poolWorkerWaitsOnCommand && databaseCommand
          ? { POOL_DATABASE_READY: databaseCommand.hash.pipe(Output.map(() => "ready")) }
          : {}),
        ...(poolDatabaseReady ? { POOL_DATABASE_READY: poolDatabaseReady } : {}),
      },
    });
    if (poolDatabaseReady)
      yield* poolWorkerAcceptance(worker, {
        adminUrl: syntheticAdminUrl,
        runtimeLogin: Output.literal("pool-runtime"),
        candidate: "0".repeat(40),
        accountId,
        key: Redacted.make("synthetic-deployment-key"),
        workerInput: "synthetic-worker-input",
        imageHash: Output.literal("synthetic-image-input"),
      });
    return worker;
  });

const syntheticAdminUrl = Redacted.make("postgres://admin@pool-database.invalid/postgres");

/**
 * The pool database command as production declares it, beside the real pool size command and a
 * tools migration keyed on the sources it reads (here one value standing for them).
 */
const poolDatabaseCommands = (options: NonNullable<Declaration["poolDatabase"]>) =>
  Effect.gen(function* () {
    const budget = yield* databasePoolBudget(
      "RuntimeDatabaseBudget",
      options.budgetDatabase ?? "synthetic-database",
      "main",
    );
    yield* Command.Exec("Migrations", {
      command: "node src/migrate.ts",
      cwd: buildContext,
      env: {
        HOSTED_SOURCES: options.toolsSource ?? "a",
        DATABASE_POOL_BUDGET_READY: budget.hash.pipe(Output.map(() => "ready")),
      },
      memo: { include: ["**"] },
    });
    return yield* poolDatabaseReadiness({
      adminUrl: syntheticAdminUrl,
      runtimeRole: "pool-runtime",
      budget,
    });
  });

const row = (
  resourceType: string,
  fqn: string,
  props: object,
  attr: object,
  more: { bindings?: { sid: string; data: unknown }[]; removalPolicy?: "retain" } = {},
) =>
  ({
    resourceType,
    fqn,
    logicalId: fqn,
    namespace: undefined,
    instanceId: fqn.toLowerCase().padEnd(32, "0").slice(0, 32),
    providerVersion: 0,
    status: "created",
    downstream: [],
    bindings: [],
    props,
    attr,
    ...more,
  }) as unknown as ResourceState;

const workerAttributes = (name: string, namespaces: Record<string, string>) => ({
  workerId: `${name}-identity`,
  workerName: name,
  accountId,
  namespace: undefined,
  logpush: undefined,
  url: undefined,
  urls: [],
  domain: undefined,
  tags: [],
  durableObjectNamespaces: namespaces,
  routes: [],
  crons: [],
  // The recorded hashes come from another checkout, so Alchemy plans an update of the code.
  hash: { assets: undefined, bundle: "recorded", input: "recorded", metadata: "recorded" },
});
const durableObject = (name: string, className: string, more: object = {}) => ({
  sid: name,
  data: { bindings: [{ type: "durable_object_namespace", name, className, ...more }] },
});

/**
 * State as production holds it: the root container already rewritten to the pinned form with the
 * hash of the old build context, both retained stores, and a PoolWorker row with its class
 * bindings.
 */
/** A retained row from an older release that the stack no longer declares. */
export const retainedScratchRow = () =>
  row(
    "Cloudflare.R2.Bucket",
    "ScratchRecords",
    { jurisdiction: "eu" },
    {
      bucketName: "basalt-production-scratchrecords",
      storageClass: "Standard",
      jurisdiction: "eu",
      accountId,
      domains: [],
      lifecycleRules: [],
    },
    { removalPolicy: "retain" },
  );

export const productionRows = (): Record<string, ResourceState> => ({
  VaultAttachments: row(
    "Cloudflare.R2.Bucket",
    "VaultAttachments",
    { jurisdiction: "eu", storageClass: "Standard" },
    {
      bucketName: "basalt-production-vaultattachments",
      storageClass: "Standard",
      jurisdiction: "eu",
      accountId,
      domains: [],
      lifecycleRules: [],
    },
    { removalPolicy: "retain" },
  ),
  PublicSiteWaitlist: row(
    "Cloudflare.D1Database",
    "PublicSiteWaitlist",
    { name: "public-site-waitlist", jurisdiction: "eu" },
    {
      databaseId: "22222222-2222-4222-8222-222222222222",
      databaseName: "public-site-waitlist",
      jurisdiction: "eu",
      accountId,
    },
    { removalPolicy: "retain" },
  ),
  PoolObservationSecrets: row(
    "Cloudflare.SecretsStore",
    "PoolObservationSecrets",
    {},
    { storeId: "3".repeat(32), storeName: "default_secrets_store", accountId },
    { removalPolicy: "retain" },
  ),
  PoolDatabase: row(
    "Command.Exec",
    "PoolDatabase",
    { command: "node --version", memo: false },
    { hash: { input: undefined } },
  ),
  ArtifactsCredentials: row(
    "Cloudflare.Worker",
    "ArtifactsCredentials",
    // The props its last apply recorded: the declaration, its class reference included.
    {
      main: entry,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        Coordinator: {
          kind: "Cloudflare.DurableObject",
          name: "ArtifactsTokenCoordinator",
          className: "ArtifactsTokenCoordinator",
        },
      },
      isExternal: true,
    },
    workerAttributes("basalt-production-artifactscredentials", {
      ArtifactsTokenCoordinator: "namespace-coordinator",
    }),
    { bindings: [durableObject("Coordinator", "ArtifactsTokenCoordinator")] },
  ),
  PoolContainer: row(
    "Cloudflare.Container",
    "PoolContainer",
    {
      image: pinnedImage,
      className: "PoolContainer",
      schedulingPolicy: "default",
      instanceType: "basic",
      maxInstances: 1,
      observability: { logs: { enabled: true } },
      // Alchemy records the marker its Container declaration adds to the props.
      isExternal: true,
    },
    {
      applicationId,
      applicationName: "basalt-production-poolcontainer",
      accountId,
      schedulingPolicy: "default",
      instances: 1,
      maxInstances: 1,
      constraints: undefined,
      affinities: undefined,
      configuration: applicationBody(pinnedImage).result.configuration,
      durableObjects: { namespaceId: "namespace-pool-container" },
      createdAt: "2026-10-01T00:00:00Z",
      version: 57,
      // The image hash is the old build context's, kept by the layer that pinned the row.
      hash: { image: "a".repeat(16), digest: `sha256:${"e".repeat(64)}` },
      dev: undefined,
    },
    {
      bindings: [
        {
          sid: "PoolContainer",
          data: { durableObjects: { namespaceId: "namespace-pool-container" } },
        },
      ],
    },
  ),
  PoolWorker: row(
    "Cloudflare.Worker",
    "PoolWorker",
    {
      main: entry,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    },
    // An apply records every class binding the settings read returns an id for, the class another
    // Worker hosts included (production's BulkUsageImport binding has one).
    workerAttributes("basalt-production-poolworker", {
      ArtifactsTokenCoordinator: "namespace-coordinator",
      PoolContainer: "namespace-pool-container",
      PoolLedger: "namespace-pool-ledger",
    }),
    {
      bindings: [
        durableObject("BulkUsageImport", "ArtifactsTokenCoordinator", {
          scriptName: "basalt-production-artifactscredentials",
        }),
        {
          sid: "PoolContainer",
          data: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "PoolContainer",
                className: "PoolContainer",
              },
            ],
            containers: [{ className: "PoolContainer", dev: undefined, hash: "a".repeat(16) }],
          },
        },
        durableObject("PoolLedger", "PoolLedger"),
        {
          sid: "POOL_MANAGEMENT_KEY",
          data: { bindings: [{ type: "secret_text", name: "POOL_MANAGEMENT_KEY" }] },
        },
        {
          sid: "VAULT",
          data: {
            bindings: [
              {
                type: "r2_bucket",
                name: "VAULT",
                bucketName: "basalt-production-vaultattachments",
                jurisdiction: "eu",
              },
            ],
          },
        },
        {
          sid: "WAITLIST",
          data: {
            bindings: [
              { type: "d1", name: "WAITLIST", databaseId: "22222222-2222-4222-8222-222222222222" },
            ],
          },
        },
      ],
    },
  ),
});

/**
 * Rows of what ArtifactsCredentials holds of other resources, as a release before recorded them:
 * the two Workers it can call and the model database connection.
 */
export const calledRows = (): Record<string, ResourceState> => ({
  ...Object.fromEntries(
    ["Api", "Catalog"].map((fqn) => [
      fqn,
      row(
        "Cloudflare.Worker",
        fqn,
        { ...service, isExternal: true },
        workerAttributes(`basalt-production-${fqn.toLowerCase()}`, {}),
      ),
    ]),
  ),
  PoolModelDatabaseConnection: row(
    "Cloudflare.Hyperdrive",
    "PoolModelDatabaseConnection",
    { origin: modelDatabaseOrigin() },
    {
      hyperdriveId: modelDatabaseId,
      name: "basalt-production-poolmodeldatabaseconnection",
      accountId,
      origin: modelDatabaseOrigin(),
      mtls: { caCertificateId: undefined, mtlsCertificateId: undefined, sslmode: undefined },
      dev: undefined,
    },
  ),
});

/** Marks settled Workers as built from another checkout, so Alchemy plans an update of their code. */
export const withCodeFromElsewhere = (
  rows: Readonly<Record<string, unknown>>,
  fqns: readonly string[],
): Record<string, ResourceState> =>
  Object.fromEntries(
    Object.entries(rows).map(([fqn, value]) => [
      fqn,
      (fqns.includes(fqn)
        ? {
            ...(value as object),
            attr: {
              ...(value as { attr: object }).attr,
              hash: {
                assets: undefined,
                bundle: "recorded",
                input: "recorded",
                metadata: "recorded",
              },
            },
          }
        : value) as ResourceState,
    ]),
  );

/** The provider observation token as provisioning recorded it, under the given account. */
export const observationTokenRow = (account: string, value: string) =>
  row(
    "Cloudflare.ApiToken.AccountApiToken",
    "PoolProviderObservationToken",
    poolObservationTokenProps(account, scope.stage),
    {
      tokenId: "4".repeat(32),
      name: "basalt-production-pool-provider-observation",
      status: "active",
      value: Redacted.make(value),
      accountId: account,
    },
    { removalPolicy: "retain" },
  );

/** An action row from an older release (a migration step the stack no longer declares). */
export const recordedActionRow = (fqn: string) =>
  ({
    kind: "action",
    actionType: "Release.Migration",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    status: "ran",
    downstream: [],
    inputHash: "recorded",
    input: { step: "synthetic" },
    output: null,
  }) as unknown as ResourceState;

export interface PlanInput {
  declared?: Declaration;
  /** Builds Alchemy's destroy plan for the stage instead of the deploy plan. */
  destroy?: boolean;
  /** Rows written into State before planning, keyed by FQN. */
  rows?: Readonly<Record<string, ResourceState>>;
  include?: readonly string[];
  /**
   * Workers to settle first: Alchemy's own apply runs their reconcile up to the upload, and the
   * row it records carries the hashes of this checkout, so the next plan can find them unchanged.
   */
  settle?: readonly string[];
  /**
   * Settle only these of the selected nodes; every other one is held at its recorded row (noop),
   * so its own provider never runs.
   */
  settleOnly?: readonly string[];
  /** Receives each settled Worker's prepared upload; by default it is never sent. */
  capture?: WorkerUploadHook["Service"]["capture"];
  /**
   * A shadow reconcile of PoolWorker: serve its recorded production settings, and answer the root
   * application's hash-only PATCH (which settling PoolWorker applies first) with the recorded read.
   */
  shadow?: boolean;
  /**
   * Applies commands without running them: each command the apply runs is appended here. Without
   * it the fixture's commands are Alchemy's own, which would run their processes.
   */
  commandRuns?: string[];
  /**
   * Records the settle apply's exit here instead of failing the plan, so a test can plan from what
   * an apply that stopped partway left in State.
   */
  applyExits?: Exit.Exit<unknown, unknown>[];
  /**
   * Container applications the account holds besides the root, by id: what the fake API lists and
   * answers for. Pass the same map to later plans so they see what an earlier apply created.
   */
  applications?: Map<string, FakeApplication>;
  /** The fake API creates the container applications it is asked to; by default it refuses them. */
  acceptContainerCreates?: boolean;
  /** A State write that fails as the store would, after Cloudflare already did what it records. */
  failCommit?: (fqn: string, value: unknown) => boolean;
}

/** Plans the declared stack against the given State with Alchemy's real planner and providers. */
export async function makePlan(context: TestContext, input: PlanInput = {}) {
  const api = await cloudflare(context, input.shadow === true, {
    applications: input.applications ?? new Map(),
    acceptCreates: input.acceptContainerCreates === true,
  });
  const inMemory = await Effect.runPromise(InMemoryService());
  for (const [fqn, value] of Object.entries(input.rows ?? {}))
    await Effect.runPromise(inMemory.set({ ...scope, fqn, value }));
  const failCommit = input.failCommit;
  const memory: typeof inMemory = failCommit
    ? {
        ...inMemory,
        set: (request) =>
          failCommit(request.fqn, request.value)
            ? Effect.fail(
                new StateStoreError({ message: `the State write of ${request.fqn} failed` }),
              )
            : inMemory.set(request),
      }
    : inMemory;
  const stack = Stack(
    scope.stack,
    {
      // The test providers carry fewer services than a real stack declares; only their behaviour matters here.
      providers: providers(api.base, input.commandRuns) as never,
      state: Layer.succeed(State, Effect.succeed(memory)),
    },
    program(input.declared ?? {}),
  );
  const plan = await Effect.runPromise(
    evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          if (input.settle?.length) {
            const selected = yield* Plan.make(compiled, { include: input.settle });
            const only = input.settleOnly;
            const settling = only
              ? {
                  ...selected,
                  resources: Object.fromEntries(
                    Object.entries(selected.resources).map(([fqn, node]) => [
                      fqn,
                      only.includes(fqn) || !node ? node : { ...node, action: "noop" as const },
                    ]),
                  ) as typeof selected.resources,
                }
              : selected;
            const applied = Apply.apply(settling).pipe(
              Effect.provideService(WorkerUploadHook, {
                // By default the upload is prepared and never sent: the attributes are the provider's own.
                capture:
                  input.capture ??
                  ((upload) =>
                    upload.proposed
                      ? Effect.succeed(upload.proposed)
                      : Effect.fail(new Error(`${upload.fqn} has no recorded row to settle`))),
              }),
            );
            if (input.applyExits) input.applyExits.push(yield* Effect.exit(applied));
            else yield* applied;
          }
          if (input.destroy) return yield* Plan.destroy({ name: scope.stack, stage: scope.stage });
          return yield* Plan.make(compiled, input.include ? { include: input.include } : {});
        }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
      { stage: scope.stage },
    ).pipe(
      provideFreshArtifactStore,
      Effect.provide(layerNonInteractive()),
      Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provideService(State, Effect.succeed(memory)),
    ) as Effect.Effect<Plan.Plan>,
  ).catch((error: unknown) => {
    throw new Error(`planning failed after ${api.requests.join(", ") || "no requests"}`, {
      cause: error,
    });
  });
  const rows = Object.fromEntries(
    await Promise.all(
      (await Effect.runPromise(memory.list(scope))).map(
        async (fqn) => [fqn, await Effect.runPromise(memory.get({ ...scope, fqn }))] as const,
      ),
    ),
  );
  return { plan, requests: api.requests, rows };
}
