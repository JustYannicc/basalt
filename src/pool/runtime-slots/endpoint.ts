import { RuntimeReadTrace, runtimeReadStep } from "../runtime-read-trace.ts";
import { refuseRuntime } from "../runtime-route-diagnostic.ts";
import {
  SlotIdentity,
  SlotRefused,
  sameControllerCode,
  sameIdentity,
  sameTarget,
  type ControllerCode,
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
  type RuntimeEnvironment,
} from "./configuration.ts";
import type { ControllerState } from "./runtime-state.ts";
import type { PoolStatus } from "../lifecycle.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import { startRuntime, verifyRuntimeLaunch } from "./startup.ts";
import { openEnvelope } from "../token.ts";
import { RuntimeActivity } from "./activity.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import { proveLegacyDrain } from "./legacy-drain.ts";
import { PeerBootstrap, type PeerBootstrapInput } from "./peer-bootstrap.ts";

export interface EndpointEnvironment extends RuntimeEnvironment {
  POOL_RUNTIME_APPLICATION_ID?: string;
  POOL_CONTAINER_APPLICATION_ID?: string;
}
export interface EndpointOptions {
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
  private options: EndpointOptions;
  constructor(
    ctx: ControllerState,
    env: EndpointEnvironment,
    role: "legacy" | "runtime",
    code: ControllerCode,
    wrap: (response: Response, lease: NativeStreamLease) => Response,
    options: EndpointOptions = {},
  ) {
    this.ctx = ctx;
    this.env = env;
    this.role = role;
    this.code = code;
    this.store = new RuntimeWitnessStore(ctx.storage, env.POOL_DEPLOYMENT_KEY ?? "");
    this.channel = new RuntimeChannel(ctx, env);
    this.activity = new RuntimeActivity(ctx.storage);
    this.wrap = wrap;
    this.options = options;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
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
    if (!sameControllerCode(proof.controllerCode, this.code)) throw new SlotRefused("identity");
    return proof;
  }
  admit(envelope: string) {
    return this.serialize(async () => {
      const proof = await this.proof(envelope);
      if (isRuntimeAttestation(proof)) throw new SlotRefused("identity");
      const retained = await this.store.retained(proof.target.slotId);
      if (retained && !retained.retired) {
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
      const configuration = runtimeConfiguration({
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
      await startRuntime(
        this.ctx,
        this.code,
        this.store,
        record,
        configuration,
        signal,
        this.options.beforeStart,
      );
      signal.throwIfAborted();
      return this.complete(target, signal);
    });
  }
  private checked(record: WitnessRecord, status: PoolStatus) {
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
    if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
      throw new SlotRefused("unhealthy");
    return {
      identity: { ...record.authorization.target, bootId: status.boot_id },
      leaseMs: Math.floor(status.policyLeaseUntil - performance.now()),
    };
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
  async health(identity: SlotIdentity, signal: AbortSignal, trace?: RuntimeReadTrace) {
    try {
      this.bound(identity);
      const { record, configuration } = await runtimeReadStep(trace, "identity", () =>
        this.store.read(identity),
      );
      if (!sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
      const status = await this.channel.health(configuration, signal, trace);
      return trace
        ? await trace.run("health_identity", async () => this.checked(record, status))
        : this.checked(record, status);
    } catch (error) {
      refuseRuntime("endpoint_identity", error);
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
    const { configuration, done } = await this.serialize(async () => {
      this.bound(identity);
      const { record, configuration } = await this.store.read(identity);
      if (!sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
      request.signal.throwIfAborted();
      return { configuration, done: await this.activity.acquire(identity) };
    }).catch((error: unknown) => refuseRuntime("endpoint_admission", error));
    const release = () => {
      this.ctx.waitUntil(done());
      return true;
    };
    try {
      await this.health(identity, request.signal);
      await this.channel.keepAlive();
      request.signal.throwIfAborted();
      return this.wrap(await this.channel.fetch(configuration, request, port), {
        signal: request.signal,
        release,
        onClose: () => {},
      });
    } catch (error) {
      release();
      throw error;
    }
  }
  drain(identity: SlotIdentity, signal: AbortSignal) {
    return this.serialize(async () => {
      await this.health(identity, signal);
      signal.throwIfAborted();
      const state = await this.activity.drain(identity);
      if (state.known || state.active !== 0 || this.role !== "legacy") return state;
      if (
        !(await proveLegacyDrain(this.ctx, identity, signal, () => this.health(identity, signal)))
      )
        return state;
      return this.activity.reconcileDrained(identity);
    });
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
    return this.serialize(async () => {
      const { record } = await this.store.read(target);
      await this.health(identity, signal);
      signal.throwIfAborted();
      if (!sameTarget(target, identity)) throw new SlotRefused("identity");
      await this.activity.retire(identity);
      signal.throwIfAborted();
      await this.ctx.container!.destroy();
      await this.store.put(target, { ...record, retired: true });
    });
  }
  async retirement(identity: SlotIdentity) {
    this.bound(identity);
    const record = await this.store.retained(identity.slotId);
    if (!record || !sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
    return { identity, retired: record.retired === true, running: this.ctx.container!.running };
  }
}
