import { crashOwnedRuntime } from "../runtime-crash-owner.ts";
import { resumeGone, resumeLayerPort, resumeRoute, toLayer } from "../stream-resume.ts";
import { assertFollowerHome, crashTargetsCell, homeTopologyPath } from "../runtime-crash-cell.ts";
import { crashAuditKey } from "../runtime-crash-contract.ts";
import { Schema } from "effect";
import { isModelLifetimePath } from "../model-lifetime-contract.ts";
import { legacyConnections } from "./legacy-drain.ts";

/** How often a boot holding a lease no instance vouches for reads its container's connections. */
export const leaseProofEveryMs = 30_000;
/** The read's own program stops at 2 s; past this the answer is unknown. */
const leaseProofLimitMs = 5_000;
/** The operator's commands answer inside the cell call's 5 s, so their read stops sooner. */
const operatorReadLimitMs = 1_500;
import { RuntimeModelLifetimes, type RuntimeControlPair } from "./model-lifetime.ts";
import { PoolUpkeepTrace } from "../upkeep-trace.ts";
import { RuntimeRetirementTrace } from "../runtime-retirement-trace.ts";
import { RuntimeRetirementMonitor, observeRuntimeRetirement } from "./retirement-observation.ts";
import { RuntimeReadTrace, runtimeReadStep } from "../runtime-read-trace.ts";
import { refuseRuntime, rememberRuntimeFailure } from "../runtime-route-diagnostic.ts";
import { RuntimeHealthRefusalLog } from "./health-refusal-log.ts";
import {
  ContainerEnded,
  SlotIdentity,
  SlotRefused,
  sameControllerCode,
  sameIdentity,
  sameTarget,
  type ControllerCode,
  type RuntimeRetirementObservation,
  type SlotTarget,
} from "./contract.ts";
import {
  decodeAdmissionProof,
  runtimeAttestationFormat,
  type AdmissionProof,
  isLaunchAuthorization,
  isRuntimeAttestation,
  type StartupWitness,
} from "./admission-proof.ts";
import { RuntimeWitnessStore, type WitnessRecord } from "./witness-store.ts";
import { RuntimeChannel } from "./channel.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  RuntimeConfiguration,
  type RuntimeEnvironment,
} from "./configuration.ts";
import type { ControllerState, OwnedRuntimeStorage } from "./runtime-state.ts";
import type { PoolStatus } from "../lifecycle.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import { startRuntime, verifyRuntimeLaunch } from "./startup.ts";
import { openEnvelope } from "../token.ts";
import { RuntimeActivity, slotKey, stillFor } from "./activity.ts";
import { shape } from "../error-shape.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import { proveLegacyDrain } from "./legacy-drain.ts";
import { PeerBootstrap, type PeerBootstrapInput } from "./peer-bootstrap.ts";
import { RuntimeMaintenance } from "./maintenance.ts";
import { admitRuntimeRestart, confirmedStopped } from "./restart-admission.ts";
import { RuntimeForcedStop, stopGracefully } from "./forced-stop.ts";
import { leakedStreamsMs } from "./forced-restart-timing.ts";
import { RuntimeStartupStop } from "./startup-stop.ts";
import { RuntimeAbandonedStop } from "./abandoned-stop.ts";
import { endedForGood, lastContainerEnd, markStopSent } from "./container-end.ts";
import type { StartupStopIntent } from "./startup-abort-contract.ts";

export interface EndpointEnvironment extends RuntimeEnvironment {
  POOL_RUNTIME_APPLICATION_ID?: string;
  POOL_CONTAINER_APPLICATION_ID?: string;
  /**
   * Only exactly "true" lets a primary on a master Home be killed. Absent everywhere unless a stage's
   * declaration binds it, which only disposable stages with test accounts should.
   */
  POOL_ALLOW_MASTER_CRASH?: string;
}
/** How long the target may take to prove it still serves, right before it is signalled. */
const crashHealthTimeoutMs = 1_000;
/** Home's management port. The channel maps it to the peer port inside a cell. */
const homeManagementPort = 8327;
export interface EndpointOptions {
  controlPair?: RuntimeControlPair;
  /** The hosting runtime object's own storage, so an ended slot drops the alarm its start armed. */
  ownStorage?: OwnedRuntimeStorage;
  beforeStart?(witness: StartupWitness): Promise<void>;
  beforeBootstrap?(identity: SlotIdentity): Promise<void>;
}

/** Reads never start compute. Start owns one durable launch, and attestation never grants routing. */
export class RuntimeEndpoint {
  private ctx: ControllerState;
  private env: EndpointEnvironment;
  private role: "legacy" | "runtime";
  private code: ControllerCode;
  private store: RuntimeWitnessStore;
  private channel: RuntimeChannel;
  private activity: RuntimeActivity;
  private wrap: (response: Response, lease: NativeStreamLease) => Response;
  private queue: Promise<unknown> = Promise.resolve();
  private retirementAttempts = 0;
  private retirementMonitor: RuntimeRetirementMonitor;
  private options: EndpointOptions;
  private forcedStop: RuntimeForcedStop;
  private refusals = new RuntimeHealthRefusalLog();
  private maintenance: RuntimeMaintenance;
  private startupStop: RuntimeStartupStop;
  private abandonedStop: RuntimeAbandonedStop;
  private modelLifetimes: RuntimeModelLifetimes;
  private leaseProofs = new Map<string, number>();
  private settleFailures = new Map<string, number>();
  constructor(
    ctx: ControllerState,
    env: EndpointEnvironment,
    role: "legacy" | "runtime",
    code: ControllerCode,
    wrap: (response: Response, lease: NativeStreamLease) => Response,
    options: EndpointOptions = {},
  ) {
    this.ctx = ctx;
    this.modelLifetimes = new RuntimeModelLifetimes(options.controlPair);
    this.retirementMonitor = new RuntimeRetirementMonitor(ctx.container!);
    this.env = env;
    this.role = role;
    this.code = code;
    // The legacy endpoint shares its object's alarm with the pool's own deadlines.
    this.store = new RuntimeWitnessStore(
      ctx.storage,
      env.POOL_DEPLOYMENT_KEY ?? "",
      role === "runtime" ? options.ownStorage : undefined,
    );
    this.startupStop = new RuntimeStartupStop(ctx, this.store);
    this.abandonedStop = new RuntimeAbandonedStop(ctx, this.store, role);
    this.channel = new RuntimeChannel(ctx, env);
    this.activity = new RuntimeActivity(ctx.storage);
    this.maintenance = new RuntimeMaintenance({
      ctx,
      store: this.store,
      channel: this.channel,
      monitor: this.retirementMonitor,
      activity: this.activity,
      bound: (target) => this.bound(target),
      checked: (record, status) => this.checked(record, status),
    });
    this.wrap = wrap;
    this.options = options;
    this.forcedStop = new RuntimeForcedStop({
      ctx,
      store: this.store,
      activity: this.activity,
      alive: (identity, signal) => this.alive(identity, signal),
      readiness: (configuration, signal) => this.channel.health(configuration, signal),
    });
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  crash(envelope: string) {
    return this.serialize(async () => {
      const cell = await crashTargetsCell(this.env.POOL_DEPLOYMENT_KEY ?? "", envelope);
      // Killing the master can lose a provider token rotation, so only a disposable stage may do
      // it, and only by naming the primary. A cell target must be a proven follower everywhere.
      const masterAllowed = !cell && this.env.POOL_ALLOW_MASTER_CRASH === "true";
      return crashOwnedRuntime(
        this.ctx,
        this.env.POOL_DEPLOYMENT_KEY ?? "",
        this.code,
        envelope,
        async (identity) => {
          if ((await this.activity.inspect(identity))?.phase !== "open")
            throw new SlotRefused("draining");
          await this.health(identity, AbortSignal.timeout(crashHealthTimeoutMs));
          if (masterAllowed) return;
          // Stays last: the owner signals right after this check returns.
          const { configuration } = await this.store.read(identity);
          await assertFollowerHome(cell ? "cell" : "primary", (signal) =>
            this.channel.fetch(
              configuration,
              new Request(`http://pool${homeTopologyPath}`, { signal }),
              homeManagementPort,
            ),
          );
        },
      );
    });
  }
  async inspectCrash(identity: SlotIdentity, nonce: string) {
    this.bound(identity);
    const record = await this.store.retained(identity.slotId);
    let leaseMs = 0;
    if (sameIdentity(record?.identity, identity)) {
      try {
        const health = await this.health(identity, AbortSignal.timeout(2_000));
        if ((await this.activity.inspect(identity))?.phase === "open") leaseMs = health.leaseMs;
      } catch {
        /* Inspection does not warm or repair an unavailable runtime. */
      }
    }
    return {
      audit: (await this.ctx.storage.get(crashAuditKey(nonce))) ?? null,
      identity: record?.identity ?? null,
      ready: leaseMs > 0,
      leaseMs,
    };
  }
  alarm() {
    return this.serialize(() => this.maintenance.alarm());
  }
  failed(identity: SlotIdentity, signal: AbortSignal) {
    return this.serialize(async () => {
      const failed = await this.maintenance.failed(identity, signal);
      const end = await this.lastEnd();
      return end ? { ...failed, end } : failed;
    });
  }
  /** How this object's container last ended, once it has; a boot found gone ends here. */
  private lastEnd() {
    return lastContainerEnd(this.ctx);
  }
  private routed(target: SlotTarget) {
    try {
      this.bound(target);
      return true;
    } catch {
      return false;
    }
  }
  private bound(target: SlotTarget) {
    const applicationId =
      this.role === "legacy"
        ? this.env.POOL_CONTAINER_APPLICATION_ID
        : this.env.POOL_RUNTIME_APPLICATION_ID;
    if (
      !applicationId ||
      target.applicationId !== applicationId ||
      target.instanceId !== this.ctx.id.toString()
    )
      throw new SlotRefused("identity");
    if (!this.ctx.container || !this.env.POOL_DEPLOYMENT_KEY) throw new SlotRefused("selection");
  }
  private async proof(envelope: string): Promise<AdmissionProof> {
    const proof = decodeAdmissionProof(
      await openEnvelope(this.env.POOL_DEPLOYMENT_KEY ?? "", runtimeAttestationFormat, envelope),
    );
    this.bound(proof.target);
    if (!sameControllerCode(proof.controllerCode, this.code))
      throw new SlotRefused("controller_code");
    return proof;
  }
  admit(envelope: string) {
    return this.serialize(async () => {
      const proof = await this.proof(envelope);
      if (isRuntimeAttestation(proof)) throw new SlotRefused("identity");
      if (proof.kind === "restart") {
        await admitRuntimeRestart(this.ctx, this.store, proof);
        return;
      }
      const retained = await this.store.retained(proof.target.slotId);
      // A retired or abandoned slot never starts again: its place may already be counted free.
      if (retained?.retired || (await this.store.abandoned(proof.target.slotId)))
        throw new SlotRefused("identity");
      if (retained) {
        const { record } = await this.store.read(proof.target);
        if (
          !sameControllerCode(record.authorization.controllerCode, proof.controllerCode) ||
          record.authorization.provider.accountId !== proof.provider.accountId ||
          record.authorization.provider.namespaceId !== proof.provider.namespaceId ||
          record.authorization.provider.applicationConfigDigest !==
            proof.provider.applicationConfigDigest ||
          record.authorization.kind !== proof.kind ||
          record.authorization.operationId !== proof.operationId ||
          record.authorization.manifestDigest !== proof.manifestDigest ||
          record.authorization.configurationFingerprint !== proof.configurationFingerprint ||
          (proof.kind === "unattested-active" && record.identity?.bootId !== proof.bootId)
        )
          throw new SlotRefused("identity");
        return;
      }
      const configuration =
        this.role === "runtime" &&
        this.env.POOL_CANDIDATE_APPLICATION_ID === proof.target.applicationId &&
        this.env.POOL_CANDIDATE_RUNTIME_CONFIGURATION
          ? Schema.decodeUnknownSync(RuntimeConfiguration)({
              ...Schema.decodeUnknownSync(RuntimeConfiguration)(
                JSON.parse(this.env.POOL_CANDIDATE_RUNTIME_CONFIGURATION),
              ),
              ...(proof.target.homePeerOrdinal !== undefined
                ? { homePeerOrdinal: proof.target.homePeerOrdinal }
                : {}),
            })
          : runtimeConfiguration({
              ...this.env,
              ...(proof.target.homePeerOrdinal !== undefined
                ? { POOL_HOME_PEER_ORDINAL: String(proof.target.homePeerOrdinal) }
                : {}),
            });
      if (
        configuration.imageInput !== proof.target.imageInput ||
        (await configurationDigest(configuration)) !== proof.configurationFingerprint
      )
        throw new SlotRefused("identity");
      let identity: SlotIdentity | undefined;
      if (proof.kind === "unattested-active") {
        const status = await this.channel.health(configuration, AbortSignal.timeout(2_000));
        if (status.boot_id !== proof.bootId) throw new SlotRefused("identity");
        identity = { ...proof.target, bootId: proof.bootId };
      } else if (this.ctx.container!.running) throw new SlotRefused("uncertain");
      await this.store.create(proof, configuration, identity);
    });
  }
  start(target: SlotTarget, signal: AbortSignal) {
    return this.serialize(async () => {
      this.bound(target);
      signal.throwIfAborted();
      const { record, configuration } = await this.store.read(target);
      if (record.identity) return this.health(record.identity, signal);
      if (!isLaunchAuthorization(record.authorization)) throw new SlotRefused("uncertain");
      if (this.ctx.container!.running) {
        if (!record.witness) throw new SlotRefused("uncertain");
        return this.complete(target, signal);
      }
      // A restart's launch witness replaces the record's; write it only over a confirmed exit.
      if (record.authorization.kind === "restart" && !(await confirmedStopped(this.ctx)))
        throw new SlotRefused("uncertain");
      await startRuntime(
        this.ctx,
        this.code,
        this.store,
        record,
        configuration,
        signal,
        this.options.beforeStart,
        () => this.startupStop.assertStart(target),
      );
      signal.throwIfAborted();
      return this.complete(target, signal);
    });
  }
  /** Stops this runtime's container when it is running but refusing; see `RuntimeForcedStop`. */
  stopRefusing(identity: SlotIdentity, refusingSince: number, signal: AbortSignal) {
    this.bound(identity);
    return this.serialize(() => this.forcedStop.stop(identity, refusingSince, signal));
  }
  abortStartup(intent: StartupStopIntent, signal: AbortSignal) {
    this.bound(intent.target);
    return this.startupStop.abort(intent, signal);
  }
  inspectStartupAbort(intent: StartupStopIntent) {
    this.bound(intent.target);
    return this.startupStop.inspect(intent);
  }
  /**
   * This boot's readiness answer, however late inside `signal`: the health read's identity checks
   * without its lease window. A forced stop reads it to tell a slow runtime from a dead one.
   */
  private async alive(identity: SlotIdentity, signal: AbortSignal) {
    this.bound(identity);
    const { record, configuration } = await this.store.read(identity);
    if (!sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
    const status = await this.channel.alive(configuration, signal);
    this.identified(record, status);
    return status;
  }
  private checked(record: WitnessRecord, status: PoolStatus) {
    this.identified(record, status);
    if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
      throw new SlotRefused("unhealthy");
    return {
      identity: { ...record.authorization.target, bootId: status.boot_id },
      leaseMs: Math.floor(status.policyLeaseUntil - performance.now()),
      // The whole grant, so the caller counts its own send as the start and the read only once.
      ...(status.policyLeaseMs ? { grantMs: status.policyLeaseMs } : {}),
      ...(status.database ? { database: status.database } : {}),
    };
  }
  /** The answer is this record's boot and launch, whatever its lease. */
  private identified(record: WitnessRecord, status: PoolStatus) {
    if (record.identity && status.boot_id !== record.identity.bootId)
      throw new SlotRefused("identity");
    if (isLaunchAuthorization(record.authorization)) {
      const witness = record.witness;
      if (
        !witness ||
        witness.configurationFingerprint !== record.authorization.configurationFingerprint ||
        status.launch?.generation !== witness.launch.generation ||
        status.launch.tokenHash !== witness.launch.tokenHash ||
        (witness.bootId && witness.bootId !== status.boot_id)
      )
        throw new SlotRefused("identity");
    }
  }
  private async complete(target: SlotTarget, signal: AbortSignal) {
    const { record, configuration } = await this.store.read(target);
    const status = await this.channel.health(configuration, signal);
    const health = this.checked(record, status);
    if (isLaunchAuthorization(record.authorization)) {
      await verifyRuntimeLaunch(this.ctx, record, status);
      if (!record.identity) await this.activity.initialize(health.identity, true);
      await this.store.put(target, {
        ...record,
        identity: health.identity,
        witness: { ...record.witness!, bootId: status.boot_id },
      });
    }
    return health;
  }
  observe(target: SlotTarget, signal: AbortSignal) {
    this.bound(target);
    return this.serialize(() => this.complete(target, signal));
  }
  /** The front layer's advert from this container's latest readiness read (#1642). */
  private resumeAdvert: PoolStatus["resume"];
  async health(identity: SlotIdentity, signal: AbortSignal, trace?: RuntimeReadTrace) {
    let record: WitnessRecord | undefined;
    let status: PoolStatus | undefined;
    try {
      this.bound(identity);
      const read = await runtimeReadStep(trace, "identity", () => this.store.read(identity));
      record = read.record;
      if (!sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
      // A stopped container whose own monitor recorded the exit says so, so it leaves at once.
      if (!this.ctx.container?.running && endedForGood(await this.lastEnd()))
        throw new ContainerEnded();
      const observed = await this.channel.health(read.configuration, signal, trace);
      status = observed;
      this.resumeAdvert = observed.resume;
      const owned = read.record;
      return trace
        ? await trace.run("health_identity", async () => this.checked(owned, observed))
        : this.checked(owned, observed);
    } catch (error) {
      rememberRuntimeFailure("endpoint_identity", error);
      if (!signal.aborted)
        this.refusals.report(identity, error, this.ctx.container?.running, record, status);
      throw error;
    }
  }
  async warm(identity: SlotIdentity, signal: AbortSignal) {
    const health = await this.health(identity, signal);
    signal.throwIfAborted();
    await this.channel.keepAlive();
    return health;
  }
  async witness(target: SlotTarget) {
    this.bound(target);
    const { record } = await this.store.read(target);
    return record.authorization.kind === "unattested-active"
      ? {
          kind: "unattested-active" as const,
          controllerCode: this.code,
          identity: record.identity,
          authorization: record.authorization,
        }
      : { kind: "witness" as const, controllerCode: this.code, witness: record.witness };
  }
  async recoveryWitness(target: SlotTarget) {
    this.bound(target);
    const { record } = await this.store.read(target);
    const end = await this.lastEnd();
    return {
      authorization: record.authorization,
      running: this.ctx.container!.running,
      identity: record.identity,
      witness: record.witness,
      ...(end ? { end } : {}),
    };
  }
  attest(envelope: string) {
    return this.serialize(async () => {
      const proof = await this.proof(envelope);
      if (!isRuntimeAttestation(proof)) throw new SlotRefused("identity");
      const { record } = await this.store.read(proof.target),
        witness = record.witness;
      const previous = record.authorization;
      if (
        !isLaunchAuthorization(previous) ||
        (previous.kind === "initial-start") !== (proof.kind === "initial-attested") ||
        (previous.kind === "restart") !== (proof.kind === "restart-attested") ||
        (previous.kind === "restart" &&
          proof.kind === "restart-attested" &&
          !sameIdentity(previous.previous, proof.previous)) ||
        !witness?.bootId ||
        !record.identity ||
        proof.bootId !== witness.bootId ||
        !sameTarget(witness.target, proof.target) ||
        proof.operationId !== witness.operationId ||
        proof.manifestDigest !== witness.manifestDigest ||
        proof.configurationFingerprint !== witness.configurationFingerprint ||
        JSON.stringify(proof.launch) !== JSON.stringify(witness.launch) ||
        proof.provider.accountId !== previous.provider.accountId ||
        proof.provider.namespaceId !== previous.provider.namespaceId ||
        proof.provider.applicationConfigDigest !== previous.provider.applicationConfigDigest
      )
        throw new SlotRefused("identity");
      await this.health(record.identity, AbortSignal.timeout(2_000));
      await this.store.put(proof.target, { ...record, attestation: proof });
    });
  }
  async ready(identity: SlotIdentity, fingerprint: string, imageInput: string) {
    const { record } = await this.store.read(identity);
    if (!record.attestation) throw new Error("Unattested active runtime");
    if (
      record.attestation.configurationFingerprint !== fingerprint ||
      identity.imageInput !== imageInput
    )
      throw new SlotRefused("identity");
    return this.health(identity, AbortSignal.timeout(2_000));
  }
  async install(identity: SlotIdentity, policy: NativeMembershipPolicy, signal: AbortSignal) {
    const { configuration } = await this.store.read(identity);
    await this.health(identity, signal);
    signal.throwIfAborted();
    await this.channel.install(configuration, policy);
    await this.health(identity, signal);
  }
  async native(identity: SlotIdentity, policy: NativeMembershipPolicy, signal: AbortSignal) {
    const { configuration } = await this.store.read(identity);
    await this.health(identity, signal);
    await this.channel.native(configuration, policy, signal);
  }
  async fetch(
    identity: SlotIdentity,
    request: Request,
    port: 8317 | 8327 | 8318,
    readOnly = false,
  ) {
    if (readOnly && port === 8317) throw new SlotRefused("identity");
    if (readOnly || port !== 8317) {
      const trace = readOnly ? new RuntimeReadTrace(request.signal) : undefined;
      const { configuration } = await runtimeReadStep(trace, "configuration", () =>
        this.store.read(identity),
      );
      await this.health(identity, request.signal, trace);
      if (!readOnly && port !== 8318) await this.channel.keepAlive();
      return this.channel.fetch(configuration, request, port, trace);
    }
    const socketData = this.modelLifetimes.data(identity, request, async () => {
      const { configuration } = await this.store.read(identity);
      await this.channel.keepAlive();
      // Readiness is read last, so a slow keep-alive can't spend the lease that admits this send.
      await this.health(identity, request.signal);
      request.signal.throwIfAborted();
      return this.channel.fetch(configuration, request, port);
    });
    if (socketData) return socketData;
    const { configuration, done } = await this.serialize(async () => {
      this.bound(identity);
      const { record, configuration } = await this.store.read(identity);
      if (!sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
      request.signal.throwIfAborted();
      // A plain HTTP call's answer streams through this instance and ends with it; a socket doesn't.
      const throughInstance =
        request.headers.get("Upgrade") === null &&
        !isModelLifetimePath(new URL(request.url).pathname);
      return { configuration, done: await this.activity.acquire(identity, throughInstance) };
    }).catch((error: unknown) => refuseRuntime("endpoint_admission", error));
    const release = () => {
      this.ctx.waitUntil(done());
      return true;
    };
    // A caller gone before the answer holds nothing here, whether or not the container still
    // answers: nobody would read that answer, so its stream wrapper would never release the count.
    const left = () => void release();
    request.signal.addEventListener("abort", left, { once: true });
    if (request.signal.aborted) left();
    try {
      await this.channel.keepAlive();
      await this.health(identity, request.signal);
      request.signal.throwIfAborted();
      // The front layer keeps a call's answer only while this container advertises the layer.
      const routed = resumeRoute(request, port, { resume: this.resumeAdvert });
      if (routed === "gone") {
        release();
        return resumeGone();
      }
      const response =
        routed.port === resumeLayerPort
          ? await toLayer(
              routed.request,
              (request, target) => this.channel.fetch(configuration, request, target),
              () => this.ctx.container?.running === true,
            )
          : await this.channel.fetch(configuration, routed.request, routed.port);
      if (isModelLifetimePath(new URL(request.url).pathname))
        return this.modelLifetimes.control(identity, request, response, release);
      return this.wrap(response, {
        signal: request.signal,
        release,
        onClose: () => {},
      });
    } catch (error) {
      release();
      throw error;
    } finally {
      request.signal.removeEventListener("abort", left);
    }
  }
  /**
   * Fences a fleet start its controller abandoned. Queued behind any start already running here, it
   * is durable before it answers, and from then on this slot is never admitted or started again, so
   * a container it finds stopped can't come back. With `stop`, a container that a first start which
   * never attested left running is then stopped, once (`RuntimeAbandonedStop`).
   */
  abandonStart(target: SlotTarget, stop = false) {
    return this.serialize(async () => {
      this.bound(target);
      await this.store.abandon(target);
      // Only behind the fence, which refuses every later start and attestation for this slot.
      if (stop) await this.abandonedStop.stop(target);
      return { stopped: !this.ctx.container!.running };
    });
  }
  /**
   * A lease no instance can vouch for ends only when the container's own read finds no established
   * connection on its model port: the legacy drain's read, unchanged. It runs only while such a lease
   * exists, at most once every 30 s per boot, and a failed, partial or late read ends nothing.
   */
  private async settleLeases(identity: SlotIdentity) {
    const pending = await this.activity.unproven(identity);
    if (!pending.unstamped.length && !pending.foreignSockets.length) return;
    const boot = `${identity.slotId}:${identity.bootId}`;
    const now = Date.now();
    if (now - (this.leaseProofs.get(boot) ?? -Infinity) < leaseProofEveryMs) return;
    this.leaseProofs.set(boot, now);
    const connections = await this.openConnections(leaseProofLimitMs);
    if (connections === 0) {
      await this.activity.releaseProven(identity, 0);
      return;
    }
    console.warn("POOL_RUNTIME_LEASES_KEPT", {
      key: await slotKey(identity.slotId),
      ordinal: identity.homePeerOrdinal ?? null,
      unstamped: pending.unstamped.length,
      foreignSockets: pending.foreignSockets.length,
      connections: connections ?? "unknown",
    });
  }
  /**
   * In the background: the read may take longer than its caller waits, and the next count read sees
   * what it ended. A settle that fails says so, at most once per proof interval per boot, since a
   * row that keeps failing fails on every read.
   */
  private settleInBackground(identity: SlotIdentity) {
    this.ctx.waitUntil(
      this.settleLeases(identity).catch(async (error: unknown) => {
        const boot = `${identity.slotId}:${identity.bootId}`;
        const now = Date.now();
        if (now - (this.settleFailures.get(boot) ?? -Infinity) < leaseProofEveryMs) return;
        this.settleFailures.set(boot, now);
        console.warn("POOL_RUNTIME_LEASES_SETTLE_FAILED", {
          key: await slotKey(identity.slotId).catch(() => null),
          ordinal: identity.homePeerOrdinal ?? null,
          reason: error instanceof SlotRefused ? error.reason : null,
          ...shape(error),
        });
      }),
    );
  }
  /**
   * The operator's override of a count that stood still on a draining runtime (`fleet-retire`), for
   * when the proof release above can't end it. It first takes the same 8317 read, as evidence for
   * the operator and never as a gate: null when the read fails or is late.
   */
  releaseStill(identity: SlotIdentity, operationId: string, signal: AbortSignal) {
    this.bound(identity);
    return this.serialize(async () => {
      signal.throwIfAborted();
      const connections = await this.openConnections(operatorReadLimitMs);
      const released = {
        ...(await this.activity.releaseStill(identity, leakedStreamsMs, signal)),
        connections,
      };
      // The cell's own record, so a release whose answer never reached the controller still shows.
      console.warn("POOL_RUNTIME_STILL_RELEASED", {
        operationId,
        slot: identity.slotId,
        ordinal: identity.homePeerOrdinal ?? null,
        ...released,
      });
      return released;
    });
  }
  /** The operator's check before `fleet-retire`: the same rules and the same read, nothing written. */
  checkStill(identity: SlotIdentity) {
    this.bound(identity);
    return this.serialize(async () => ({
      ...(await this.activity.checkStill(identity, leakedStreamsMs)),
      connections: await this.openConnections(operatorReadLimitMs),
    }));
  }
  /**
   * The legacy drain's read of established connections on the model port, for the proof release and
   * the operator alike: null when there's no running container, or the read fails or passes `limitMs`.
   */
  private async openConnections(limitMs: number) {
    const container = this.ctx.container;
    if (!container?.exec || !container.running) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      legacyConnections({ exec: container.exec.bind(container) }).catch(() => null),
      new Promise<null>((late) => (timer = setTimeout(() => late(null), limitMs))),
    ]).finally(() => clearTimeout(timer));
  }
  /** The stream count as stored, read without draining; an untracked boot's count is unknown. */
  async streamCount(identity: SlotIdentity) {
    this.bound(identity);
    this.settleInBackground(identity);
    const row = await this.activity.inspect(identity);
    return row
      ? { active: row.active, known: row.known, ...stillFor(row) }
      : { active: 0, known: false };
  }
  drain(identity: SlotIdentity, signal: AbortSignal) {
    const trace = new PoolUpkeepTrace("endpoint");
    const fields = { ordinal: identity.homePeerOrdinal };
    return trace.run(
      "drain_queue",
      () =>
        this.serialize(async () => {
          // Before the health read, so a drain whose health read fails still ends the leases the
          // container shows are over. That read refuses a misrouted drain, which settles nothing.
          if (this.routed(identity)) this.settleInBackground(identity);
          await trace.run("drain_health", () => this.health(identity, signal), fields);
          signal.throwIfAborted();
          const state = await trace.run(
            "drain_activity",
            () => this.activity.drain(identity),
            fields,
          );
          trace.event("drain_recheck", { ...fields, active: state.active, known: state.known });
          if (state.known || state.active !== 0 || this.role !== "legacy") return state;
          if (
            !(await trace.run(
              "legacy_drain_proof",
              () =>
                proveLegacyDrain(this.ctx, identity, signal, () => this.health(identity, signal)),
              fields,
            ))
          )
            return state;
          return this.activity.reconcileDrained(identity);
        }),
      fields,
    );
  }
  async bootstrapPeer(input: PeerBootstrapInput, signal: AbortSignal) {
    if (this.role !== "legacy") throw new SlotRefused("identity");
    const { record, configuration } = await this.store.read(input.identity);
    if (
      !sameIdentity(record.identity, input.identity) ||
      configuration.homePeerOrdinal !== undefined ||
      record.authorization.configurationFingerprint !== input.configurationFingerprint
    )
      throw new SlotRefused("identity");
    await this.health(input.identity, signal);
    await this.options.beforeBootstrap?.(input.identity);
    return new PeerBootstrap(this.ctx, (identity, signal) => this.health(identity, signal)).run(
      input,
      signal,
    );
  }
  retire(target: SlotTarget, identity: SlotIdentity, signal: AbortSignal) {
    const trace = new RuntimeRetirementTrace("endpoint", ++this.retirementAttempts);
    let began = false;
    const work = this.serialize(async () => {
      const { record } = await trace.run("witness_read", () => this.store.read(target));
      await trace.run("health", () => this.health(identity, signal), undefined, signal);
      signal.throwIfAborted();
      if (!sameTarget(target, identity)) throw new SlotRefused("identity");
      await trace.run("activity_retire", () => this.activity.retire(identity));
      // From the retiring latch on, the stop no longer follows its caller's 2 s budget: the latch
      // refuses every later drain and retire, and Home's drain of claimed refreshes may take the
      // whole grace. The retirement read sees the stop end.
      await trace.run("monitor_attach", async () => this.retirementMonitor.start(identity));
      await this.store.stopSent(target, Date.now());
      await markStopSent(this.ctx);
      await trace.run(
        "stop",
        () => stopGracefully(this.ctx.container!, () => (began = true)),
        (stopped) => ({ stopped }),
      );
      await trace.run("retired_record", () =>
        this.store.retire(target, { ...record, retired: true }),
      );
    });
    this.ctx.waitUntil(work.catch(() => {}));
    // A caller that stops waiting once the stop began has done its part; the retirement read sees
    // the stop end, so a stop longer than the caller's budget is no failure.
    return new Promise<void>((resolve, reject) => {
      const abort = () => (began ? resolve() : reject(signal.reason));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async retirement(
    identity: SlotIdentity,
    signal?: AbortSignal,
  ): Promise<RuntimeRetirementObservation> {
    const trace = new RuntimeRetirementTrace("endpoint", ++this.retirementAttempts);
    this.bound(identity);
    const observed = await observeRuntimeRetirement(
      identity,
      this.ctx.container!,
      this.store,
      this.activity,
      trace,
      this.retirementMonitor,
      signal,
    );
    const end = observed.running ? undefined : await this.lastEnd();
    return end ? { ...observed, end } : observed;
  }
}
