import { reportWhenDue } from "./reporting.ts";
import { creditRoutingPaths, handleCreditRouting } from "./credit-routing-http.ts";
export { PoolRuntime } from "./runtime-do.worker.ts";
import type { PoolRuntime } from "./runtime-do.worker.ts";
import { RuntimeHandoff, type HandoffEnvironment } from "./runtime-slots/integration.ts";
import { handleRuntimeHandoff } from "./runtime-slots/http.ts";
import { runtimeHandoffPath } from "./runtime-slots/handoff-command.ts";
import { deploymentReadinessPath, handleDeploymentReadiness } from "./deployment-readiness.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { installNativePolicy } from "./native-policy-install.ts";
import { handleRemovalIntent, removalIntentPath } from "./removal-intent.ts";
import { pricedSummary } from "./model-history/priced-summary.ts";
import { publishAccountObservations } from "./account-observation-publish.ts";
import { appUsage } from "./model-history/app-usage.ts";
import { AppModels } from "./app-models.ts";
import { appModelPath } from "./app-model-contract.ts";
import { appAttributionReady } from "./model-history/schema.ts";
import type { ModelIdentity } from "./model-membership.ts";
import { accountMirrorPath, handleAccountKeyMirror } from "./account-key-mirror.ts";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { captureProduct, type ProductEvent, type TelemetryEnv } from "../telemetry/product.ts";
import type { ProductEventCallback } from "../setup/product-events.ts";
import { isControlPath } from "../../apps/pool/contract.ts";
import { PoolControl } from "./attribution.ts";
import { HomeClient } from "./control.ts";
import { ComputerHome } from "./computer-home.ts";
import { Computers } from "./computers.ts";
import { accessPath } from "./access-contract.ts";
import { requirePoolUse } from "./authorization.ts";
import { isPoolAcquisitionPath } from "./connection-policy.ts";
import { requireActivePoolOrganization } from "./organization-access.ts";
import { failureResponse, unavailable } from "./json.ts";
import { isPublicModelPath, PoolLifecycle, poolPort } from "./lifecycle.ts";
import { nativeControlPath, nativeModelHeader, nativeSessionPath } from "./native-contract.ts";
import { nativeResponse, nativeSession } from "./native-response.worker.ts";
import { hasActiveHomeApiKey, homeApiKeyCandidates, type HomeApiKeyLookup } from "./model-auth.ts";
import { PriceUpkeep } from "./prices.ts";
import { OverviewPrices } from "./overview-prices.ts";
import { PlanAllowances } from "./allowances/registry.ts";
import { managedCapPath, managedUsagePath, PoolUsage, summaryPath } from "./pool-usage.ts";
import { timePoolRead } from "./read-timing.ts";
import { inventoryCron, reportPoolInventory } from "./inventory.ts";
import { probePool } from "./availability.ts";
import { availabilityCron, validProbeTarget } from "./availability-config.ts";
import { availabilityRuntime } from "./availability-runtime.ts";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import { observeAutomaticPool } from "./automatic-observation.ts";
import { automaticRecoveryAuthority } from "./automatic-authority.ts";
import { reportPoolStorage } from "./inventory-storage.ts";
import { migrateCodexWebSockets, type CodexWebSocketPlan } from "./codex-websockets.ts";
import { captureHomeRequests } from "./model-history/capture.ts";
import { withHistoryDatabase } from "./model-history/database.ts";
import { handleModelHistory, modelHistoryPath } from "./model-history/http.ts";
import {
  handleUsageSeries,
  lastSuccessAtPath,
  poolOverviewPath,
  poolPersonalOverviewPath,
  poolUsageSeriesPath,
} from "./model-history/series-http.ts";
import {
  handleModelHistoryOperation,
  historyBackfillPath,
  historySchemaApplyPath,
  historySchemaCatalogPath,
} from "./model-history/operator.ts";
import { handleUsageImport, modelImportPath } from "./model-history/import-http.ts";
import { handleOwnerUsageImport, ownerModelImportPath } from "./model-history/import-owner-http.ts";
import { importAccountTargets } from "./model-history/import-account-targets.ts";
import { handleSelfUsageImport, selfModelImportPath } from "./model-history/self-import-http.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { NativeMemberships } from "./membership.ts";
import { membershipPath } from "./membership-contract.ts";
import { readNativeMembership } from "./membership-read.ts";
import { HomeMembership } from "./home-membership.ts";
import { accountAcquisitionPath } from "./account-acquisition-contract.ts";
import { NativeStreams } from "./native-streams.ts";
import { createPoolLifecycle } from "./runtime.worker.ts";
import { forwardPoolRequest } from "./forward.worker.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import { readRuntimeHealth } from "./runtime-health.ts";
import { captureError } from "../telemetry/sentry.ts";
import { brand } from "../../brand.ts";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { importRemovalPath } from "./import-removal/contract.ts";
import { ImportRemoval } from "./import-removal/operation.ts";
import { handleImportRemoval } from "./import-removal/http.ts";
import { removalSnapshot } from "./import-removal/snapshot.ts";
import {
  handleRuntimeRecovery,
  RecoveryRefused,
  RuntimeRecovery,
  runtimeRecoveryPath,
} from "./runtime-recovery.ts";
import { poolRelease, poolReleasePath } from "./release.ts";
import { historyTrafficPath } from "./model-history/traffic.ts";
import { readPoolReliabilitySlo } from "./model-history/reliability-slo.ts";

export interface PoolEnvironment extends TelemetryEnv, SentryEnv, HandoffEnvironment {
  PoolContainer: DurableObjectNamespace<PoolContainer>;
  PoolRuntime?: DurableObjectNamespace<PoolRuntime>;
  POOL_DATABASE_URL: string;
  POOL_AUTH_DATABASE?: Hyperdrive;
  POOL_MANAGEMENT_KEY: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_CLAUDE_QUOTA_DIAGNOSTIC?: string;
  POOL_IMAGE_HASH: string;
  POOL_DEPLOYMENT_KEY?: string;
  POOL_MODEL_HISTORY_ENABLED?: string;
  POOL_AVAILABILITY_TARGET?: string;
  POOL_AUTOMATIC_RECOVERY_TARGET?: string;
  TOOLS_SERVICE: Fetcher;
}

export class PoolContainer extends DurableObject<PoolEnvironment> {
  private lifecycle: Promise<PoolLifecycle>;
  private handoff: RuntimeHandoff;
  private control: PoolControl;
  private mirrorHome: HomeClient;
  private computers: Computers;
  private appModels: AppModels;
  private prices: PriceUpkeep;
  private overviewPrices: OverviewPrices;
  private usage: PoolUsage;
  private allowances: PlanAllowances;
  private managementReadyUntil = 0;
  private managementWarming?: Promise<void>;
  private memberships: NativeMemberships;
  private modelStreams = new NativeStreams();
  private protection: RuntimeProtection;
  private importRemoval: ImportRemoval;
  private recovery: RuntimeRecovery;

  constructor(ctx: DurableObjectState, env: PoolEnvironment) {
    super(ctx, env);
    this.handoff = new RuntimeHandoff(
      ctx,
      env,
      { candidate: productionOpsRelease, workerInput: poolWorkerRevision },
      {
        wrap: nativeResponse,
        ...(env.PoolRuntime
          ? {
              remote: (target) => {
                const namespace = env.PoolRuntime!.jurisdiction("eu");
                return namespace.get(namespace.idFromString(target.instanceId));
              },
            }
          : {}),
      },
    );
    this.lifecycle = createPoolLifecycle(ctx, env);
    this.recovery = new RuntimeRecovery(
      {
        get instanceId() {
          return ctx.id.toString();
        },
        imageHash: env.POOL_IMAGE_HASH,
        release: productionOpsRelease,
        running: () => ctx.container?.running ?? false,
        status: () => {
          if (!ctx.container) throw new Error("Pool container unavailable");
          return readRuntimeHealth(
            ctx.container.getTcpPort(8318),
            env.POOL_MANAGEMENT_KEY,
            AbortSignal.timeout(2_000),
          );
        },
        restart: (beforeStop) =>
          this.handoff.recover(async () => {
            this.managementReadyUntil = 0;
            return (await this.lifecycle).restart(beforeStop);
          }),
      },
      ctx.storage,
      Date.now,
      automaticRecoveryAuthority(ctx.storage, env.POOL_AUTOMATIC_RECOVERY_TARGET, (pool) =>
        this.automaticRecoveryCondition(pool),
      ),
    );
    this.protection = new RuntimeProtection(this.modelStreams, {
      check: async (signal) => {
        const selected = await this.handoff.status(signal);
        if (selected) return selected;
        if (!ctx.container) throw new Error("Pool container unavailable");
        return readRuntimeHealth(ctx.container.getTcpPort(8318), env.POOL_MANAGEMENT_KEY, signal);
      },
      defer: (work) => ctx.waitUntil(work),
      unavailable: (count, diagnostic) => {
        console.error(
          diagnostic.action === "closed"
            ? "POOL_ACTIVE_STREAMS_CLOSED"
            : "POOL_RUNTIME_PROTECTION_UNAVAILABLE",
          {
            code: "pool_protection_unavailable",
            count,
            ...diagnostic,
          },
        );
        ctx.waitUntil(captureError(env, "pool_failure", "/v1"));
      },
    });
    const onProductEvent: ProductEventCallback = (event: ProductEvent, accountId: string) => {
      ctx.waitUntil(captureProduct(env, event, accountId));
    };
    const home = async (path: string, init?: RequestInit) => {
      const request = new Request(new URL(path, "http://pool"), init);
      return this.handoff.forward(request, 8327, undefined, async (forwarded, prepared) => {
        if (!env.POOL_MANAGEMENT_KEY) throw new Error("Pool management key is missing");
        forwarded.signal.throwIfAborted();
        await this.legacyManagementReady();
        forwarded.signal.throwIfAborted();
        if (!ctx.container) throw new Error("Pool container unavailable");
        const headers = new Headers(forwarded.headers);
        headers.set("X-Management-Key", env.POOL_MANAGEMENT_KEY);
        prepared();
        return ctx.container.getTcpPort(8327).fetch(new Request(forwarded, { headers }));
      });
    };
    this.mirrorHome = new HomeClient(home, Date.now, () => this.control.invalidateViews());
    this.overviewPrices = new OverviewPrices(this.mirrorHome, ctx.storage);
    this.control = new PoolControl(ctx.storage, {
      nativeMembership: (pool, organization) =>
        readNativeMembership(env.TOOLS_SERVICE, env.POOL_APP_SIGNING_KEY, pool, organization),
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      audience: (pool) => this.computers.audience(pool),
      defer: (work) => ctx.waitUntil(work),
      home,
      onProductEvent,
    });
    this.prices = new PriceUpkeep(
      new HomeClient(home, Date.now, () => this.control.invalidateViews()),
      ctx.storage,
    );
    this.allowances = new PlanAllowances(ctx.storage);
    this.usage = new PoolUsage({
      allowances: this.allowances,
      storage: ctx.storage,
      client: new HomeClient(home, Date.now, () => this.control.invalidateViews()),
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      audience: (pool) => this.computers.audience(pool),
      defer: (work) => ctx.waitUntil(work),
      collection: this.control.collection,
      officialSummary: (input) =>
        withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
          pricedSummary(db, input, (targets) => this.overviewPrices.read(targets)),
        ),
      appUsage: (input) =>
        env.POOL_MODEL_HISTORY_ENABLED !== "true"
          ? Promise.resolve(undefined)
          : withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
              appUsage(db, input),
            ),
      permissions: (pool, user) => this.computers.permissions(pool, user),
    });
    this.computers = new Computers({
      retirePool: (pool, at) => this.memberships.retire(pool, at),
      storage: ctx.storage,
      home: new ComputerHome(
        new HomeClient(home, Date.now, () => this.control.invalidateViews()),
        onProductEvent,
      ),
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      onProductEvent,
      usage: this.usage,
    });
    this.appModels = new AppModels({
      storage: ctx.storage,
      home: new ComputerHome(this.mirrorHome),
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      now: () => Date.now(),
      schedule: async (at) => {
        const alarm = await ctx.storage.getAlarm();
        if (alarm === null || alarm > at) await ctx.storage.setAlarm(at);
      },
      ready: () =>
        env.POOL_MODEL_HISTORY_ENABLED !== "true"
          ? Promise.resolve(false)
          : withHistoryDatabase(
              env.POOL_AUTH_DATABASE?.connectionString,
              async (db) =>
                (await appAttributionReady(db)) &&
                (await db.query("SELECT 1 FROM basalt_model_history_cursor LIMIT 1")).rows.length >
                  0,
            ),
      forward: (request, identity) => this.forward(request, identity),
    });
    const membership = new HomeMembership(
      new HomeClient(home, Date.now, () => this.control.invalidateViews()),
    );
    this.memberships = new NativeMemberships({
      storage: ctx.storage,
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      read: (pool, organization) =>
        readNativeMembership(env.TOOLS_SERVICE, env.POOL_APP_SIGNING_KEY, pool, organization),
      actual: (pool) => membership.actual(pool),
      invalidateView: (pool) => this.control.invalidateViews(pool),
      reconcile: (pool, accounts) => membership.reconcile(pool, accounts),
      install: async (policy) => {
        if (await this.handoff.selected()) return this.handoff.slots.install(policy);
        const container = ctx.container;
        if (!container) return unavailable();
        // Durable dirty authority already vetoes model use while a stopped container has no policy.
        // Warming happens after the host commits, outside its ten-second acknowledgement deadline.
        if (!container.running && policy.dirty) return;
        await installNativePolicy(
          container,
          {
            signingKey: env.POOL_APP_SIGNING_KEY,
            managementKey: env.POOL_MANAGEMENT_KEY,
          },
          policy,
        );
      },
      abort: (pool) => {
        this.handoff.abortPool(pool);
        this.modelStreams.abortPool(pool);
        this.computers.abortPool(pool);
      },
      schedule: async (at) => {
        const alarm = await ctx.storage.getAlarm();
        if (alarm === null || alarm > at) await ctx.storage.setAlarm(at);
      },
    });
    const database = new URL(env.POOL_DATABASE_URL);
    this.importRemoval = new ImportRemoval({
      read: (selection) =>
        withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
          removalSnapshot(db, selection),
        ),
      ready: () => this.managementReady(),
      home: (path, init) => this.mirrorHome.response(path, init),
      storage: ctx.storage,
      secret: env.POOL_APP_SIGNING_KEY,
      release: productionOpsRelease,
      databaseOrigin: `${database.hostname}:${database.port || "5432"}${database.pathname}`,
    });
  }

  private managementReady(): Promise<void> {
    return this.handoff.ready(() => this.legacyManagementReady());
  }

  private async legacyManagementReady(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running && Date.now() < this.managementReadyUntil) return;
    if (!this.managementWarming) {
      this.managementWarming = (async () => {
        await timePoolRead("readiness", async () => (await this.lifecycle).warm());
        this.managementReadyUntil = Date.now() + 30_000;
      })().finally(() => {
        this.managementWarming = undefined;
      });
    }
    return this.managementWarming;
  }

  async availabilityProbe(pool: string) {
    const selected = await this.handoff.selected();
    if (selected) {
      const runtime = availabilityRuntime(
        {
          running: true,
          getTcpPort: (port) => ({
            fetch: (input, init) => {
              if (port !== 8318 && port !== 8327) throw new Error("Invalid probe port");
              return this.handoff.probeFetch(new Request(input, init), port);
            },
          }),
        },
        this.env.POOL_MANAGEMENT_KEY,
        this.env.POOL_APP_SIGNING_KEY,
      );
      return probePool(pool, {
        ...runtime,
        native: (policy, signal) => this.handoff.probeNative(policy, signal),
        membership: (target) => this.memberships.inspect(target),
      });
    }
    return probePool(pool, {
      ...availabilityRuntime(
        this.ctx.container,
        this.env.POOL_MANAGEMENT_KEY,
        this.env.POOL_APP_SIGNING_KEY,
      ),
      membership: (target) => this.memberships.inspect(target),
    });
  }

  private async automaticRecoveryCondition(pool: string) {
    if (await this.handoff.selected()) return "unknown" as const;
    return observeAutomaticPool(pool, {
      ...availabilityRuntime(
        this.ctx.container,
        this.env.POOL_MANAGEMENT_KEY,
        this.env.POOL_APP_SIGNING_KEY,
      ),
      membership: (target) => this.memberships.inspect(target),
    });
  }

  async automaticRecoveryObservation(pool: string) {
    if (await this.handoff.selected()) throw new RecoveryRefused(409);
    const [runtime, condition] = await Promise.all([
      this.recovery.inspect(),
      this.automaticRecoveryCondition(pool),
    ]);
    return { enabled: this.env.POOL_AUTOMATIC_RECOVERY_TARGET === pool, runtime, condition };
  }

  async alarm() {
    await this.appModels.tick().catch(() => console.error("POOL_APP_MODEL_KEY_CLEANUP_PENDING"));
    await this.memberships.tick();
    await this.computers.expire();
    await this.handoff.warm(() => this.lifecycle.then((lifecycle) => lifecycle.warm()));
    await reportWhenDue(this.ctx.storage, "first-request", (progress) =>
      this.computers.observeUsage(undefined, true, progress),
    );
    await this.control.expire();
    this.ctx.waitUntil(
      this.allowances.refresh().catch(() => console.error("POOL_PLAN_ALLOWANCE_REFRESH_PENDING")),
    );
    await this.prices.run();
    await this.overviewPrices.refresh();
    // Usage is a report: a slow or failing read must not hold the pool's own upkeep.
    await reportWhenDue(this.ctx.storage, "usage", (progress) =>
      this.usage.observe(progress),
    ).catch((error: unknown) => console.error("Pool usage observation failed", error));
    await reportWhenDue(this.ctx.storage, "account-observations", () =>
      publishAccountObservations(this.env.TOOLS_SERVICE, this.env.POOL_APP_SIGNING_KEY),
    ).catch(() => console.error("POOL_ACCOUNT_OBSERVATIONS_PENDING"));
    if (this.env.POOL_MODEL_HISTORY_ENABLED === "true") {
      try {
        await reportWhenDue(this.ctx.storage, "model-history", (progress) =>
          withHistoryDatabase(this.env.POOL_AUTH_DATABASE?.connectionString, async (db) => {
            const result = await captureHomeRequests(db);
            progress.rows = result.state === "active" ? result.scanned : 0;
          }),
        );
      } catch {
        console.error("POOL_MODEL_HISTORY_FAILURE count=1");
      }
    }
  }

  async migrationInventory(): Promise<void> {
    await reportPoolStorage(this.ctx.storage);
  }

  deploymentIdentity() {
    return {
      candidate: productionOpsRelease,
      workerInput: poolWorkerRevision,
      imageHash: this.env.POOL_IMAGE_HASH,
      instanceId: this.ctx.id.toString(),
    };
  }

  async deploymentReady() {
    return {
      ...this.deploymentIdentity(),
      ...(await this.handoff.deploymentReady(() =>
        this.lifecycle.then((lifecycle) => lifecycle.deploymentReady()),
      )),
    };
  }

  async migrateCodexWebSockets(approved?: Pick<CodexWebSocketPlan, "digest" | "pending">) {
    return migrateCodexWebSockets(this.mirrorHome, approved);
  }

  async runtimeHandoff(request: Request) {
    return handleRuntimeHandoff(
      request,
      this.handoff,
      {
        candidate: productionOpsRelease,
        workerInput: poolWorkerRevision,
      },
      this.env.POOL_DEPLOYMENT_KEY ?? "",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    try {
      await requireActivePoolOrganization(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        tools: this.env.TOOLS_SERVICE,
      });
    } catch (error) {
      return failureResponse(error);
    }
    if (pathname === runtimeRecoveryPath && (await this.handoff.selected()))
      return Response.json(
        { error: "Selected runtime recovery requires the release handoff" },
        { status: 409 },
      );
    if (pathname === runtimeRecoveryPath)
      return handleRuntimeRecovery(
        request,
        {
          inspectRuntimeRecovery: (id) => this.recovery.inspect(id),
          recoverRuntime: (approval) => this.recovery.run(approval),
        },
        this.env.POOL_APP_SIGNING_KEY,
      );
    if (pathname === importRemovalPath)
      return handleImportRemoval(
        request,
        this.importRemoval,
        this.env.POOL_APP_SIGNING_KEY,
        `https://${brand.host}`,
      );
    if (pathname === removalIntentPath)
      return handleRemovalIntent(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        refresh: (pool) => this.memberships.refresh(pool),
        selected: async (pool) => {
          const policy = await this.memberships.authority(pool);
          if (!policy) return unavailable();
          return policy.accounts;
        },
        record: (pool, references, actor, operation, issuedAt) =>
          this.control.recordRemovalIntent(pool, references, actor, operation, issuedAt),
      });
    if (pathname === accountAcquisitionPath) return this.control.acquire(request);
    if (pathname === membershipPath) {
      try {
        const recovery = await this.memberships.reserve(request);
        this.ctx.waitUntil(
          recovery
            ? this.memberships.ensure(recovery.pool, recovery.organization).catch(() => {})
            : this.memberships.tick(),
        );
        return new Response(null, { status: 204 });
      } catch {
        return Response.json({ error: "membership_unavailable" }, { status: 503 });
      }
    }
    if (pathname === appModelPath) return this.appModels.handle(request);
    if (pathname === accountMirrorPath)
      return handleAccountKeyMirror(request, {
        home: this.mirrorHome,
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
      });
    if (pathname === accessPath) return this.computers.access(request);
    if (pathname === nativeControlPath) return this.computers.nativeControl(request);
    if (pathname === nativeSessionPath) {
      try {
        return nativeSession(await this.computers.nativeSession(request));
      } catch (error) {
        return failureResponse(error);
      }
    }
    let poolClaims: Awaited<ReturnType<typeof requirePoolUse>>;
    if (isControlPath(pathname)) {
      try {
        poolClaims = await requirePoolUse(request, {
          signingKey: this.env.POOL_APP_SIGNING_KEY,
          previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
          permissions: (pool, user) => this.computers.permissions(pool, user),
        });
      } catch (error) {
        return failureResponse(error);
      }
    }
    if (creditRoutingPaths.has(pathname))
      return handleCreditRouting(request, {
        home: this.mirrorHome,
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        ensure: (pool, organization) => this.memberships.ensure(pool, organization),
      });
    if (
      pathname === poolUsageSeriesPath ||
      pathname === lastSuccessAtPath ||
      pathname === poolOverviewPath ||
      pathname === poolPersonalOverviewPath
    )
      return handleUsageSeries(request, {
        home: this.mirrorHome,
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        connectionString: this.env.POOL_AUTH_DATABASE?.connectionString,
        currentPrices: (targets) => this.overviewPrices.readTable(targets),
      });
    if (
      pathname === managedUsagePath ||
      pathname === managedCapPath ||
      pathname.startsWith("/__setup/v1/")
    )
      return this.computers.handle(request);
    if (pathname === "/pool/v1/computers" || pathname === "/pool/v1/setup-context") {
      const response = await this.computers.context(request);
      // Connect reads this when it opens; copying a setup prompt next mints a key in Home, so start
      // a cold pool now rather than on that click. Only an authorized read may start the shared
      // container. A failed warm is retried by the next Home call.
      if (response.ok) this.ctx.waitUntil(this.managementReady().catch(() => {}));
      return response;
    }
    if (pathname === summaryPath || pathname === "/pool/v1/usage/capacity")
      return this.usage.handle(request);
    if (pathname === ownerModelImportPath)
      return handleOwnerUsageImport(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        connectionString: this.env.POOL_AUTH_DATABASE?.connectionString,
        importAccounts: (pool) => importAccountTargets(this.mirrorHome, pool),
      });
    if (pathname === modelHistoryPath || pathname === modelImportPath)
      return (pathname === modelHistoryPath ? handleModelHistory : handleUsageImport)(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        connectionString: this.env.POOL_AUTH_DATABASE?.connectionString,
        permissions: (pool, caller) => this.computers.permissions(pool, caller),
        currentPrices: (targets) => this.overviewPrices.readTable(targets),
        importAccounts: (pool) => importAccountTargets(this.mirrorHome, pool),
      });
    if (pathname === selfModelImportPath)
      return handleSelfUsageImport(request, {
        signingKey: this.env.POOL_APP_SIGNING_KEY,
        previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
        connectionString: this.env.POOL_AUTH_DATABASE?.connectionString,
        permissions: (pool, caller) => this.computers.permissions(pool, caller),
      });
    if (isControlPath(pathname)) {
      try {
        // History, capacity and setup reads above do not depend on Home membership or readiness.
        if (poolClaims && !isPoolAcquisitionPath(request.method, pathname))
          await this.memberships.ensure(poolClaims.pool, poolClaims.organization);
      } catch (error) {
        return failureResponse(error);
      }
      return this.control.handle(request);
    }
    const port = poolPort(pathname);
    if (!port && pathname !== "/__warm") return new Response(null, { status: 404 });
    return this.forward(request);
  }

  private forward(request: Request, appModel?: ModelIdentity): Promise<Response> {
    const port = poolPort(new URL(request.url).pathname);
    return forwardPoolRequest(request, port, {
      ...(appModel === undefined ? {} : { appModel }),
      env: this.env,
      computers: this.computers,
      memberships: this.memberships,
      streams: this.modelStreams,
      lifecycle: this.lifecycle,
      protection: this.protection,
      route: (request, target, pool, legacy, beforeDispatch) =>
        this.handoff.forward(request, target, pool, legacy, beforeDispatch),
      warm: (legacy) => this.handoff.warm(legacy),
      fetch: (forwarded, target) => {
        if (!this.ctx.container) throw new Error("Pool container unavailable");
        return this.ctx.container.getTcpPort(target).fetch(forwarded);
      },
      defer: (work) => this.ctx.waitUntil(work),
    });
  }
}

function singleton(env: PoolEnvironment) {
  // Jurisdiction constrains the DO itself. Container placement is configured separately.
  return env.PoolContainer.jurisdiction("eu").getByName("control-plane");
}

export async function handlePoolWorkerRequest(
  request: Request,
  env: PoolEnvironment,
  lookupHomeApiKey: HomeApiKeyLookup = hasActiveHomeApiKey,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  // Answered here, without waking the container.
  if (pathname === poolReleasePath) return poolRelease(request, env);
  if (
    pathname === removalIntentPath ||
    pathname === importRemovalPath ||
    pathname === appModelPath ||
    pathname === accountMirrorPath ||
    pathname === nativeControlPath ||
    pathname === nativeSessionPath
  )
    return singleton(env).fetch(request);
  if (
    pathname !== accountAcquisitionPath &&
    pathname !== accessPath &&
    pathname !== membershipPath &&
    !isControlPath(pathname) &&
    !isPublicModelPath(pathname) &&
    !pathname.startsWith("/__setup/v1/")
  ) {
    return new Response(null, { status: 404 });
  }
  if (isPublicModelPath(pathname)) {
    if (request.headers.has(nativeModelHeader)) return singleton(env).fetch(request);
    const { supplied, values } = homeApiKeyCandidates(request);
    if (!supplied) return modelAuthResponse(401, "Missing API key");
    if (values.length === 0) return modelAuthResponse(401, "Invalid API key");
    try {
      const connectionString = env.POOL_AUTH_DATABASE?.connectionString;
      if (!connectionString) return modelAuthResponse(503, "Authentication service unavailable");
      if (!(await lookupHomeApiKey(connectionString, values)))
        return modelAuthResponse(401, "Invalid API key");
    } catch {
      return modelAuthResponse(503, "Authentication service unavailable");
    }
  }
  return singleton(env).fetch(request);
}

function modelAuthResponse(status: 401 | 503, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Only a service binding that explicitly selects this named entrypoint can invoke it. */
export class PoolOperations extends WorkerEntrypoint<PoolEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/automatic-recovery-observation") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const pool = new URL(request.url).searchParams.get("pool") ?? undefined;
      if (!validProbeTarget(pool)) return new Response(null, { status: 400 });
      try {
        return Response.json(await singleton(this.env).automaticRecoveryObservation(pool), {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        if (error instanceof RecoveryRefused)
          return Response.json(
            { error: "runtime_recovery_refused" },
            { status: error.status, headers: { "Cache-Control": "no-store" } },
          );
        throw error;
      }
    }
    if (path === "/availability") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const pool = new URL(request.url).searchParams.get("pool") ?? undefined;
      if (!validProbeTarget(pool)) return new Response(null, { status: 400 });
      return Response.json(await singleton(this.env).availabilityProbe(pool), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === runtimeHandoffPath) return singleton(this.env).runtimeHandoff(request);
    if (path === deploymentReadinessPath)
      return handleDeploymentReadiness(
        request,
        {
          candidate: productionOpsRelease,
          workerInput: poolWorkerRevision,
          imageHash: this.env.POOL_IMAGE_HASH,
        },
        this.env.POOL_DEPLOYMENT_KEY ?? "",
        (phase) =>
          phase === "adoption"
            ? singleton(this.env).deploymentIdentity()
            : singleton(this.env).deploymentReady(),
      );
    if (path === runtimeRecoveryPath) return singleton(this.env).fetch(request);
    if (
      [
        historySchemaCatalogPath,
        historySchemaApplyPath,
        historyBackfillPath,
        historyTrafficPath,
      ].includes(path)
    )
      return handleModelHistoryOperation(request, this.env.POOL_AUTH_DATABASE?.connectionString);
    if (path !== "/codex-websockets") return new Response(null, { status: 404 });
    try {
      let approved: Pick<CodexWebSocketPlan, "digest" | "pending"> | undefined;
      if (request.method === "POST") {
        const value: unknown = await request.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("digest" in value) ||
          !("pending" in value) ||
          typeof value.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.digest) ||
          typeof value.pending !== "number" ||
          !Number.isSafeInteger(value.pending) ||
          value.pending < 0
        )
          return new Response(null, { status: 400 });
        approved = { digest: value.digest, pending: value.pending };
      } else if (request.method !== "GET") return new Response(null, { status: 405 });
      return Response.json(await singleton(this.env).migrateCodexWebSockets(approved), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
}

export default {
  fetch(request: Request, env: PoolEnvironment) {
    return handlePoolWorkerRequest(request, env);
  },
  async scheduled(event: ScheduledEvent, env: PoolEnvironment) {
    if (event.cron === availabilityCron) {
      await runAvailabilityProbe(
        env,
        (pool) => singleton(env).availabilityProbe(pool),
        (pool) => {
          if (env.POOL_MODEL_HISTORY_ENABLED !== "true")
            throw new Error("Model request history is disabled");
          return withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
            readPoolReliabilitySlo(db, pool),
          );
        },
      );
      return;
    }
    if (event.cron === inventoryCron) {
      await reportPoolInventory(env.POOL_AUTH_DATABASE);
      await singleton(env).migrationInventory();
      return;
    }
    const response = await singleton(env).fetch("http://pool/__warm");
    if (!response.ok) throw new Error("Pool prewarming failed");
  },
};
