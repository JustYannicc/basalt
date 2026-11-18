/**
 * Stand-ins for the modules runtime-image-release.ts imports that talk to the live PoolWorker,
 * the Alchemy state store's version endpoint or native state rows. The release test redirects only
 * runtime-image-release.ts's own imports here; deployStack, Alchemy Plan/Apply, the Command provider,
 * configureReleaseFleet and runtimeReleaseImage stay real, and waitReleaseObservation is the real
 * function on a virtual clock.
 */
import { Effect, Layer, Schema } from "effect";
import { referenceImageInput } from "../runtime-release-bootstrap.ts";
import { Stack } from "alchemy/Stack";
import { State, type StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import type { RuntimeConfiguration } from "../../../src/pool/runtime-slots/configuration.ts";
import type { RuntimeColor } from "../../../src/pool/image-release-plan.ts";
import { BarrierRefusal } from "../refusal.ts";
import type { RuntimeReleaseRecord } from "../runtime-release-journal.ts";
import type { BaselineController } from "../baseline-controller.ts";
import { RuntimeReleaseState } from "../runtime-release-state.ts";
import type { RuntimeCommandAction } from "../runtime-command-rpc.ts";
import { waitReleaseObservation as liveWait } from "../runtime-release-readiness.ts";
import { runtimeNamespaceReader } from "../runtime-namespace-read.ts";
import { runtimeNamespaceAttachment, type NamespaceAttachment } from "../provisioning-namespace.ts";
import type { productionPoolWorker } from "./production-pool-worker.ts";
import { fleetClassName } from "../../../src/pool/fleet-deployment.ts";
import {
  accountId,
  baselineConfiguration,
  candidateInput,
  deploymentKey,
  desiredConfiguration,
  monitorPool,
  workerName,
  world,
  type Application,
} from "./runtime-release-world.ts";

const retained = (app: Application) => ({
  resource: app.resource,
  image: {
    image: app.image.ref,
    inputHash: app.input,
    digest: app.image.digest,
    applicationId: app.id,
  },
  attributes: {
    applicationId: app.id,
    applicationName: app.name,
    accountId,
    version: app.version,
    createdAt: "2026-11-17T00:00:00Z",
    // The native row keeps the created attributes; a created application records zero instances.
    instances: 0,
    maxInstances: 1,
    schedulingPolicy: "default",
    constraints: { jurisdiction: "eu" },
    configuration: { image: app.image.ref, instance_type: "basic" },
    durableObjects: { namespaceId: app.namespaceId },
    hash: { image: app.input, digest: app.image.digest },
  },
  instanceId: app.id,
  props: {},
});

/** Native PoolWorker and container rows, read from the provider world they describe. */
export const runtimeReleaseState = (_stack: Pick<CompiledStack, "name" | "stage">) =>
  Effect.sync(() => {
    const w = world();
    const blue = w.byColor("blue"),
      green = w.byColor("green");
    return Schema.decodeUnknownSync(RuntimeReleaseState)({
      target: { worker: workerName, accountId },
      applications: {
        root: retained(w.root),
        ...(blue ? { blue: retained(blue) } : {}),
        ...(green ? { green: retained(green) } : {}),
      },
      configuration: baselineConfiguration,
      deploymentKey,
      monitorPool,
    });
  });

export const runtimeReleaseDesired = (_stack: CompiledStack) =>
  Effect.succeed({ imageInput: candidateInput, configuration: desiredConfiguration });

let journal: RuntimeReleaseRecord | undefined;
type ControllerCode = BaselineController["code"];
let sourceController: ControllerCode | undefined;
/** `source` is the live-proven controller code a settled or aborted prior candidate left. */
export const resetJournal = (source?: ControllerCode) => {
  journal = undefined;
  sourceController = source;
};
export const runtimeReleaseJournal = (_stack: CompiledStack, _writer: unknown, _key: string) =>
  Effect.succeed({
    head: async () => (journal ? { record: structuredClone(journal) } : { sourceController }),
    read: async () => (journal ? structuredClone(journal) : undefined),
    write: async (next: RuntimeReleaseRecord) => {
      journal = structuredClone(next);
    },
  });
export const readJournal = () => journal;

export const assertReleaseStateVersion = (_stack: CompiledStack) => Effect.void;
export const assertMigrationActivationSettled = (..._args: unknown[]) => Effect.void;
export const resumeForwardRelease = (..._args: unknown[]) => Effect.succeed(undefined);
export const verifyBoundProviderObservation = async (_input: unknown) => {
  world().events.push("provider-observation");
};

const baseline = {
  code: { candidate: "9".repeat(40), workerInput: "8".repeat(64) },
  target: { worker: workerName, accountId },
  imageHash: "7".repeat(16),
  versions: [{ versionId: "version-baseline", percentage: 100 }],
  workerDigest: "6".repeat(64),
  readinessDigest: "5".repeat(64),
};
export const readBaselineController = (_stack: CompiledStack, source?: ControllerCode) =>
  Effect.succeed(source ? { ...baseline, code: source } : baseline);
/** The production choice (baseline-controller.ts) over the stand-in reader. */
export const releaseBaselineController = (
  stack: CompiledStack,
  head: { record?: { baselineController?: BaselineController }; sourceController?: ControllerCode },
) =>
  head.record?.baselineController
    ? Effect.succeed({ controller: head.record.baselineController })
    : readBaselineController(stack, head.record ? undefined : head.sourceController).pipe(
        Effect.map((controller) => ({ controller })),
      );
export const readBaselineControllerKey = (_stack: CompiledStack) => Effect.succeed(deploymentKey);
export const baselineControllerHealth = async () => ({
  instanceId: "instance-root",
  bootId: "boot-baseline",
  checkedAt: Date.now(),
});

/** Deployment readiness reports the new controller code only after a phase activated PoolWorker. */
export async function releaseCodeReady(_state: RuntimeReleaseState, code: { candidate: string }) {
  const w = world();
  if (!w.events.some((event) => event.startsWith("activate:PoolWorker")))
    throw new BarrierRefusal("runtime-release-code-not-adopted", "PoolWorker");
  w.events.push(`code-ready:${code.candidate.slice(0, 8)}`);
  return { bootId: "boot-code", instanceId: "instance-code" };
}

/**
 * releaseSelectedReady's image and health checks. The deployment-readiness identity, final
 * selection and policy-digest comparisons need the live readiness connection and are not modelled.
 */
export async function releaseSelectedReady(
  _state: RuntimeReleaseState,
  _code: unknown,
  client: ReturnType<typeof clientOver>,
  desiredInput: string,
) {
  const before = await client.inspect();
  if (
    before.selection?.active.target.imageInput !== desiredInput ||
    before.selection.active.fenced ||
    before.selection.active.retirement
  )
    throw new BarrierRefusal("runtime-release-selected-image-not-current", "PoolWorker");
  return client.health();
}

const clientOver = (desired?: RuntimeConfiguration) => {
  const w = world();
  return {
    inspect: async () => w.inspect(),
    health: async () => w.health(),
    fleet: async (operationId?: string) => w.fleet(operationId),
    adopt: async () => {
      w.adopt();
    },
    promote: async (applicationId: string, operationId: string, pool: string) => {
      if (pool !== monitorPool) throw new BarrierRefusal("runtime-release-public-pool", pool);
      await w.promote(applicationId, operationId, desired ?? baselineConfiguration);
    },
    selectedCurrent: (imageInput: string, configuration: RuntimeConfiguration) => {
      if (stop?.at === "configured" && Object.keys(journal?.configurations ?? {}).length)
        throw new BarrierRefusal("synthetic-source-stopped", "PoolWorker");
      return w.selectedCurrent(imageInput, configuration);
    },
    observeProvider: async () => {
      throw new BarrierRefusal("runtime-release-provider-observation-unmodeled");
    },
    call: async (action: RuntimeCommandAction) => {
      if (action.action === "fleet-configure")
        return { result: w.configure(action.operationId, action.configuration) };
      if (action.action === "image-inspect") return { result: null };
      throw new BarrierRefusal("runtime-release-command-unmodeled", action.action);
    },
  };
};
/** The controller client, answered by the world's PoolWorker controller. */
export const runtimeReleaseClient = (input: { desiredConfiguration?: RuntimeConfiguration }) =>
  Effect.sync(() => {
    if (stop?.at === "bind" && journal?.baseline.applications[stop.color])
      throw stopped(stop.color);
    return clientOver(input.desiredConfiguration);
  });

let production: ReturnType<typeof productionPoolWorker> | undefined;
/** The production-shaped PoolWorker the release's class path and bootstraps both talk to. */
export const installProductionWorker = (value: ReturnType<typeof productionPoolWorker>) => {
  production = value;
};
/** What each bootstrap attached to, and the Worker writes made while it ran. */
export const bootstrapAttachments: NamespaceAttachment[] = [];
export const bootstrapCalls = { writes: 0 };
export const resetBootstrap = () => {
  bootstrapAttachments.length = 0;
  bootstrapCalls.writes = 0;
};
let stop:
  | { color: RuntimeColor; at: "bootstrap" | "bind" }
  | { color?: undefined; at: "configured" }
  | undefined;
const stopped = (color: RuntimeColor) =>
  new BarrierRefusal("synthetic-source-stopped", fleetClassName(color));
/**
 * Stops the release before this colour's bootstrap, or, with `bind`, at the first controller client
 * its bind phase asks for: after the bootstrap created the application and the release saved its
 * native baseline (runtime-image-release.ts, right after bootstrapReleaseApplication). With
 * `configured`, it stops at the first read after its fleet configuration was sent and retained.
 */
export const stopRelease = (value: typeof stop) => {
  stop = value;
};

/**
 * Fleet bootstrap: the real namespace read and attachment builder against the same production
 * PoolWorker the code phases' class path wrote (no `exports`, untagged), then one empty application
 * on the root image, as provisioning creates it.
 */
export const bootstrapReleaseApplication = (
  _stack: CompiledStack,
  options: { color: RuntimeColor },
) =>
  Effect.gen(function* () {
    const w = world();
    const worker = production!;
    const writes = worker.log.writes;
    const baseline = yield* Effect.gen(function* () {
      const reader = yield* runtimeNamespaceReader(accountId, workerName);
      return yield* Effect.promise(() => reader.baseline());
    }).pipe(Effect.provide(worker.layer));
    const name = fleetClassName(options.color);
    const attachment = runtimeNamespaceAttachment(baseline, {
      accountId,
      namespace: { className: name, binding: name },
    });
    bootstrapCalls.writes += worker.log.writes - writes;
    if (stop?.color === options.color && stop.at === "bootstrap") throw stopped(options.color);
    bootstrapAttachments.push(attachment);
    w.createApplication(options.color, w.root.image, yield* referenceImageInput(w.root.image.ref));
  });

/** The real wait on a virtual clock, so a pending observation costs no wall time. */
export function waitReleaseObservation<A>(
  read: () => Promise<A>,
  accepted: (value: A) => boolean,
  resource: string,
  milliseconds?: number,
) {
  let now = 0;
  return liveWait(read, accepted, resource, milliseconds, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    deadline: () => ({ signal: new AbortController().signal, dispose: () => {} }),
  });
}

export const provisioningStack = Stack(
  "basalt-provisioning",
  {
    providers: Layer.empty,
    state: Layer.effect(
      State,
      Effect.sync(() => provisioningState()),
    ),
  },
  Effect.succeed({}),
);
let provisioningState = (): Effect.Effect<StateService> => {
  throw new Error("Provisioning state not installed");
};
export const installProvisioningState = (state: StateService) => {
  provisioningState = () => Effect.succeed(state);
};
