import { createHash } from "node:crypto";
import { poolWorkerRevision } from "../../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import type { RuntimeColor } from "../../../src/pool/image-release-plan.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  type RuntimeConfiguration,
} from "../../../src/pool/runtime-slots/configuration.ts";
import type {
  SlotIdentity,
  SlotRecord,
  SlotSelection,
  SlotTarget,
} from "../../../src/pool/runtime-slots/contract.ts";
import type { FleetConfiguration } from "../../../src/pool/runtime-fleet/configuration.ts";
import { canonical, digest } from "../manifest.ts";
import { BarrierRefusal } from "../refusal.ts";

// One synthetic production: the Cloudflare Workers settings, Containers applications and instances,
// the managed registry and the PoolWorker controller's slot selection. The release reads and mutates
// only this, and the test refuses every other network call.

export const accountId = "0".repeat(32);
// Matches the fixture Worker attributes (fixture.ts), which name the script by its logical id.
export const workerName = "PoolWorker";
export const candidate = "c".repeat(40);
export const deploymentKey = "a".repeat(64);
export const monitorPool = "pool-fixture";
export const origin = "https://pool.fixture.invalid";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function publishedImage(name: string) {
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: { Labels: { "io.signalbox.pool.oauth-completion-receipts": "1" } },
    name,
  });
  const configDigest = sha(config);
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
  const imageDigest = sha(manifest);
  return {
    ref: `registry.cloudflare.com/${accountId}/basalt-pool@${imageDigest}`,
    digest: imageDigest,
    config,
    configDigest,
    manifest,
  };
}
type PublishedImage = ReturnType<typeof publishedImage>;
const baselineImage = publishedImage("baseline");
export const candidateImage = publishedImage("candidate");
/** A published image no release in this world names, for a fleet serving the wrong build. */
export const foreignImage = publishedImage("foreign");
export const foreignInput = "3c".repeat(8);
const baselineInput = "1a".repeat(8);
export const candidateInput = "2b".repeat(8);
const images = [baselineImage, candidateImage];

/** The PoolWorker runtime settings that runtimeConfiguration reads. */
export const runtimeEnvironment = (imageInput: string) => ({
  POOL_DATABASE_URL: "postgresql://fixture:fixture@fixture.invalid/basalt_pool",
  POOL_MANAGEMENT_KEY: "f".repeat(64),
  POOL_APP_SIGNING_KEY: "e".repeat(64),
  POOL_IMAGE_HASH: imageInput,
});
export const baselineConfiguration = runtimeConfiguration(runtimeEnvironment(baselineInput));
export const desiredConfiguration = runtimeConfiguration(runtimeEnvironment(candidateInput));

interface Instance {
  id: string;
  state: "running" | "stopped";
  image: string;
  /** The Durable Object whose container this is; a slot target names it as `instanceId`. */
  owner: string;
}
export interface Application {
  resource: "PoolContainer" | "PoolRuntimeBlue" | "PoolRuntimeGreen";
  id: string;
  name: string;
  version: number;
  image: PublishedImage;
  input: string;
  namespaceId: string;
  instances: Instance[];
}

/** The root PoolContainer object, which is the controller and serves the legacy slot itself. */
const controllerId = "controller-root";

export function createWorld() {
  const events: string[] = [];
  const applications = new Map<string, Application>();
  const root: Application = {
    resource: "PoolContainer",
    id: "application-root",
    name: "basalt-pool-root",
    version: 3,
    image: baselineImage,
    input: baselineInput,
    namespaceId: "namespace-root",
    instances: [
      { id: "instance-root", state: "running", image: baselineImage.ref, owner: controllerId },
    ],
  };
  applications.set(root.id, root);
  const byColor = (color: RuntimeColor) =>
    [...applications.values()].find(
      (app) => app.resource === (color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen"),
    );
  /** The settings of PoolWorker's active version, as the Workers settings API returns them. */
  let settings: { name: string; type: "plain_text"; text: string }[] = [];
  const activatePoolWorker = () => {
    // The real PoolWorker declaration binds every fleet application that exists when it uploads.
    settings = [
      { name: "POOL_IMAGE_HASH", type: "plain_text", text: root.input },
      // deployment.ts binds the input computed from this candidate's pool image source.
      { name: "POOL_DESIRED_IMAGE_INPUT", type: "plain_text", text: candidateInput },
    ];
    for (const color of ["blue", "green"] as const) {
      const app = byColor(color);
      if (!app) continue;
      const prefix = `POOL_${color.toUpperCase()}`;
      settings.push(
        { name: `${prefix}_APPLICATION_ID`, type: "plain_text", text: app.id },
        { name: `${prefix}_IMAGE_HASH`, type: "plain_text", text: app.input },
      );
    }
    events.push(`activate:PoolWorker:${settings.length}`);
  };

  const controller = {
    code: { candidate, workerInput: poolWorkerRevision },
    selection: undefined as SlotSelection | undefined,
    permissions: new Map<
      string,
      { operationId: string; digest: string; configuration: FleetConfiguration; enabled: boolean }
    >(),
    latest: undefined as string | undefined,
    started: new Map<string, string>(),
    boots: 0,
  };
  const target = (app: Application, slotId: string, instanceId: string): SlotTarget => ({
    format: "pool-runtime-slot-v1",
    controllerId,
    slotId,
    applicationId: app.id,
    applicationVersion: String(app.version),
    instanceId,
    imageDigest: app.image.digest,
    imageInput: app.input,
  });
  const boot = (slot: SlotTarget): SlotIdentity => ({
    ...slot,
    bootId: `boot-${++controller.boots}`,
  });

  /** Fleet runtimes the enabled permission started, each on its application's own pins. */
  let fleetRows: { target: SlotTarget; phase: string; active: number }[] = [];
  /** Demand starts a fleet runtime on the latest permission's active application. */
  const serveFleet = () => {
    const permission = controller.latest
      ? controller.permissions.get(controller.latest)
      : undefined;
    if (!permission?.enabled) throw new BarrierRefusal("runtime-fleet-not-enabled", "PoolWorker");
    const pins = permission.configuration.applications.find(
      (app) => app.color === permission.configuration.active,
    )!;
    const app = applications.get(pins.applicationId)!;
    fleetRows.push({
      target: {
        ...target(app, `fleet-${fleetRows.length + 1}`, `fleet-${app.id}`),
        homePeerOrdinal: fleetRows.length + 1,
      },
      phase: "ready",
      active: 1,
    });
    events.push(`fleet-serve:${app.id}`);
  };
  /**
   * The controller alarm's retirement of a drained primary, mirroring src/pool/runtime-slots:
   * retirement.ts:100-103 fences the slot and records `started`; retirement.ts:109-114 and :128 call
   * driver.retire; endpoint.ts:477 is that retire's `this.ctx.container!.destroy()`, which removes
   * the slot object's container from its application; retirement.ts:131-133 require it retired and
   * not running, and :147-150 delete the role from the selection. Production retires from the
   * controller alarm after promotion returns, so here it spans two controller reads.
   * Assumption: a destroyed container is absent from the application's active instance list.
   */
  const retirementTick = () => {
    const selection = controller.selection;
    // Once a primary is promoted, the fleet drains runtimes on any other application on idle.
    const active = selection?.active.target;
    if (active && active.slotId !== "legacy") {
      const drained = fleetRows.filter((row) => row.target.applicationId !== active.applicationId);
      if (drained.length) {
        fleetRows = fleetRows.filter((row) => row.target.applicationId === active.applicationId);
        for (const row of drained) events.push(`fleet-drain:${row.target.applicationId}`);
      }
    }
    const draining = selection?.draining;
    if (!selection || !draining) return;
    if (!draining.retirement) {
      controller.selection = {
        ...selection,
        draining: {
          ...draining,
          fenced: true,
          retirement: { operationId: `retire-${draining.target.slotId}`, status: "started" },
        },
      };
      events.push(`retire:started:${draining.target.applicationId}`);
      return;
    }
    const app = applications.get(draining.target.applicationId)!;
    app.instances = app.instances.filter((row) => row.owner !== draining.target.instanceId);
    events.push(`destroy:${app.id}:${draining.target.instanceId}`);
    const next = { ...selection };
    delete next.draining;
    controller.selection = next;
  };

  const health = () => {
    const active = controller.selection?.active;
    if (!active?.identity)
      throw new BarrierRefusal("runtime-release-health-unavailable", "PoolWorker");
    const app = applications.get(active.target.applicationId);
    if (
      !app?.instances.some(
        (row) => row.owner === active.target.instanceId && row.state === "running",
      )
    )
      throw new BarrierRefusal("runtime-release-active-not-running", "PoolWorker");
    return {
      instanceId: active.identity.instanceId,
      bootId: active.identity.bootId,
      checkedAt: Date.now(),
    };
  };

  const fleet = (operationId?: string) => ({
    permission: operationId
      ? controller.permissions.get(operationId)
      : controller.latest
        ? controller.permissions.get(controller.latest)
        : undefined,
    resources: [...fleetRows],
    bindings: (["blue", "green"] as const).flatMap((color) => {
      const prefix = `POOL_${color.toUpperCase()}`;
      const id = settings.find((row) => row.name === `${prefix}_APPLICATION_ID`)?.text;
      const imageInput = settings.find((row) => row.name === `${prefix}_IMAGE_HASH`)?.text;
      return id && imageInput ? [{ color, applicationId: id, imageInput }] : [];
    }),
  });

  const inspect = () => {
    // Each read is a controller alarm turn; retirement advances only across turns, as in production.
    retirementTick();
    return {
      controllerCode: controller.code,
      selection: controller.selection,
      policies: [
        { pool: monitorPool, organization: "organization-fixture", revision: 1, dirty: false },
      ],
      denials: [],
      digest: "d".repeat(64),
    };
  };

  /** The controller side of client.adopt(): the running root runtime becomes the legacy primary. */
  const adopt = () => {
    if (controller.selection) return health();
    if (!root.instances.some((row) => row.owner === controllerId && row.state === "running"))
      throw new BarrierRefusal("runtime-release-root-not-running", "PoolContainer");
    // integration.ts:89-93: the legacy target's instance is the controller object itself.
    const slot = target(root, "legacy", controllerId);
    controller.selection = {
      epoch: 1,
      active: { target: slot, identity: boot(slot), fenced: false },
    };
    // The adopted process runs the baseline settings, so selectedCurrent is false until promotion.
    controller.started.set(controllerId, "baseline");
    events.push("adopt:legacy");
    return health();
  };

  /**
   * The controller side of client.promote() as runtime-image-release.ts:369-379 calls it: start the
   * candidate primary on the inactive application with the desired startup settings, swap it into
   * `active` and move the previous primary to `draining` for the alarm to retire.
   */
  const promote = async (
    applicationId: string,
    operationId: string,
    configuration: RuntimeConfiguration,
  ) => {
    const before = controller.selection;
    if (before?.active.target.applicationId === applicationId) return health();
    if (!before) throw new BarrierRefusal("runtime-release-promotion-unselected", "PoolWorker");
    const app = applications.get(applicationId);
    if (!app || app.resource === "PoolContainer")
      throw new BarrierRefusal("runtime-release-promotion-target", applicationId);
    const instanceId = `runtime-${operationId}`;
    app.instances.push({
      id: `instance-${operationId}`,
      state: "running",
      image: app.image.ref,
      owner: instanceId,
    });
    controller.started.set(instanceId, await configurationDigest(configuration));
    const slot = target(app, operationId, instanceId);
    const previous: SlotRecord = { ...before.active };
    controller.selection = {
      epoch: before.epoch + 1,
      active: { target: slot, identity: boot(slot), fenced: false },
      draining: previous,
    };
    events.push(`promote:${app.id}`);
    return health();
  };

  const configure = (operationId: string, configuration: FleetConfiguration) => {
    const retained = controller.permissions.get(operationId);
    if (retained) return retained;
    const permission = {
      operationId,
      digest: digest(canonical(configuration)),
      configuration,
      enabled: true,
    };
    controller.permissions.set(operationId, permission);
    controller.latest = operationId;
    events.push(`fleet-configure:${operationId}`);
    return permission;
  };

  const selectedCurrent = async (imageInput: string, configuration: RuntimeConfiguration) => {
    const active = controller.selection?.active;
    if (
      !active?.identity ||
      active.identity.imageInput !== imageInput ||
      active.fenced ||
      active.retirement
    )
      return false;
    return (
      controller.started.get(active.target.instanceId) ===
      (await configurationDigest(configuration))
    );
  };

  const createApplication = (color: RuntimeColor, image: PublishedImage, input: string) => {
    if (byColor(color)) return byColor(color)!;
    const app: Application = {
      resource: color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
      id: `application-${color}`,
      name: `basalt-pool-${color}`,
      version: 1,
      image,
      input,
      namespaceId: `namespace-${color}`,
      instances: [],
    };
    applications.set(app.id, app);
    events.push(`create:${app.id}`);
    return app;
  };
  /** The inactive application's image rollout: a new version with no instance until promotion. */
  const buildInactive = (color: RuntimeColor) => {
    const app = byColor(color);
    if (!app) throw new BarrierRefusal("runtime-release-build-target-missing", color);
    if (app.image === candidateImage) return;
    app.image = candidateImage;
    app.input = candidateInput;
    app.version++;
    events.push(`build:${app.id}`);
  };

  /** The applications whose instance lists were read, in order. */
  const instanceReads: string[] = [];
  const json = (result: unknown, init?: ResponseInit) =>
    Response.json({ success: true, errors: [], messages: [], result, result_info: {} }, init);
  /** The Cloudflare API, managed registry and public pool origin that the release scripts call. */
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin && url.pathname === "/pool/v1/pool")
      return new Response(null, { status: 401 });
    if (url.hostname === "registry.cloudflare.com") {
      const image = images.find(
        (row) => url.pathname.endsWith(row.digest) || url.pathname.endsWith(row.configDigest),
      );
      if (!image) return new Response(null, { status: 404 });
      return new Response(url.pathname.includes("/blobs/") ? image.config : image.manifest);
    }
    if (url.hostname !== "api.cloudflare.com")
      throw new Error(`Fixture network refused ${url.origin}`);
    const base = `/client/v4/accounts/${accountId}`;
    if (
      request.method === "POST" &&
      url.pathname === `${base}/containers/registries/registry.cloudflare.com/credentials`
    )
      return json({ username: "fixture", password: "synthetic" }, { status: 201 });
    if (request.method !== "GET")
      throw new Error(`Fixture API refused ${request.method} ${url.pathname}`);
    if (url.pathname === `${base}/workers/scripts/${workerName}/settings`)
      return json({ bindings: settings });
    const match = new RegExp(`^${base}/containers/applications/([^/]+)(/instances-v2)?$`).exec(
      url.pathname,
    );
    const app = match && applications.get(decodeURIComponent(match[1]!));
    if (!app)
      return Response.json(
        { success: false, errors: [{ code: 1000, message: "not found" }] },
        { status: 404 },
      );
    if (match[2]) instanceReads.push(app.id);
    if (match[2])
      return Response.json({
        success: true,
        errors: [],
        // Assumption: `state=active` leaves out stopped instances.
        result: app.instances
          .filter((row) => url.searchParams.get("state") !== "active" || row.state !== "stopped")
          .map((row) => ({
            id: row.id,
            application_id: app.id,
            image: row.image,
            status: { state: row.state },
          })),
        result_info: {},
      });
    return json({
      id: app.id,
      name: app.name,
      account_id: accountId,
      version: app.version,
      instances: app.instances.length,
      configuration: { image: app.image.ref },
    });
  };

  return {
    events,
    instanceReads,
    root,
    byColor,
    activatePoolWorker,
    controller,
    inspect,
    health,
    fleet,
    serveFleet,
    adopt,
    promote,
    configure,
    selectedCurrent,
    createApplication,
    buildInactive,
    fetch,
  };
}
export type World = ReturnType<typeof createWorld>;

/** The release modules' stand-ins reach the one world the test created. */
let current: World | undefined;
export const installWorld = (world: World) => {
  current = world;
};
export const world = () => {
  if (!current) throw new Error("No release fixture world installed");
  return current;
};
