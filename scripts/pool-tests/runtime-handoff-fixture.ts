import { RuntimeSqlite } from "./runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import assert from "node:assert/strict";
import { Schema } from "effect";
import {
  RuntimeEndpoint,
  type EndpointEnvironment,
  type EndpointOptions,
} from "../../src/pool/runtime-slots/endpoint.ts";
import { runtimeRequest } from "../../src/pool/runtime-slots/transport.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  type StartupOptions,
} from "../../src/pool/runtime-slots/configuration.ts";
import type {
  ControllerCode,
  SlotIdentity,
  SlotTarget,
} from "../../src/pool/runtime-slots/contract.ts";
import { launchTokenHash } from "../../src/pool/launch-ledger.ts";
import {
  launchGenerationHeader,
  launchTokenHashHeader,
  policyHealthHeader,
} from "../../src/pool/runtime-health.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  policyPrefix,
  policyUsePrefix,
  type NativeMembershipPolicy,
} from "../../src/pool/membership-contract.ts";
import { fixture, signingKey } from "../../src/pool/test/control.ts";
import type { NativeStreamLease } from "../../src/pool/native-streams.ts";
import { legacyDrainProgram } from "../../src/pool/runtime-slots/legacy-drain.ts";
import { peerBootstrapInspectionProgram } from "../../src/pool/runtime-slots/peer-bootstrap.ts";
import peerProgram from "../../src/pool/home-peer-program.json" with { type: "json" };
import type { HomePeerSource } from "../../src/pool/runtime-slots/peer-access.ts";
import { runtimeStopTiming } from "../../src/pool/runtime-slots/forced-stop.ts";

// Fixtures never sleep through production's stop waits; a test that needs one mocks it.
runtimeStopTiming.confirmExit = async () => {};
runtimeStopTiming.stopGrace = async () => {};

const responseModule = "../../src/pool/native-response.worker.ts";
const {
  nativeResponse,
  nativeControlPair,
}: {
  nativeControlPair: NonNullable<EndpointOptions["controlPair"]>;
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
} = await import(responseModule);

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const Policy = Schema.Struct({
  pool: Schema.String,
  organization: Schema.String,
  revision: Schema.Number,
  expiresAt: Schema.Number,
  accounts: Schema.Array(Schema.String),
  dirty: Schema.Boolean,
});
const Assertion = Schema.Struct({
  pool: Schema.String,
  revision: Schema.Number,
  expiresAt: Schema.Number,
});

export async function handoffRuntime(
  target: SlotTarget,
  env: EndpointEnvironment,
  options: {
    running?: boolean;
    storage?: RuntimeSqlite;
    role?: "legacy" | "runtime";
    home?: Awaited<ReturnType<typeof fixture>>["home"];
    endpoint?: EndpointOptions;
    /** The endpoint's code; an object on another Worker version runs code the controller lacks. */
    code?: ControllerCode;
  } = {},
) {
  const home = options.home ?? (await fixture()).home;
  if (!options.home) {
    home.addFile("auth-a");
    home.addGroup("pool-a", 1, ["auth-a"]);
  }
  const storage = options.storage ?? new RuntimeSqlite();
  const background: Promise<unknown>[] = [];
  const stops = new Set<() => void>();
  const losses = new Set<(error: unknown) => void>();
  const calls = {
    signals: [] as number[],
    start: 0,
    destroy: 0,
    keepAlive: 0,
    health: 0,
    home: 0,
    model: 0,
    install: [] as NativeMembershipPolicy[],
    interceptions: [] as { host: string; source: HomePeerSource }[],
    /** The reasons this object reset itself with, in order. */
    resets: [] as string[],
  };
  let running = options.running ?? false,
    bootId = crypto.randomUUID();
  let startup: StartupOptions = {
    enableInternet: true,
    env: {
      POOL_MANAGEMENT_KEY: env.POOL_MANAGEMENT_KEY,
      POOL_APP_SIGNING_KEY: env.POOL_APP_SIGNING_KEY,
    },
  };
  const policies = new Map<string, NativeMembershipPolicy>();
  const helper = { starts: 0, witness: undefined as object | undefined };
  const hooks = {
    health: async (): Promise<Response | void> => {},
    keepAlive: async () => {},
    install: async (_policy: NativeMembershipPolicy) => {},
    model: async (_request: Request): Promise<Response | undefined> => undefined,
    connections: async () => 0,
    /**
     * Runs before a running container is destroyed; a throw is a destroy the platform failed. It is
     * synchronous, so a destroy that succeeds settles in the same turn it was called.
     */
    destroy: (): void => {},
    /**
     * Whether SIGTERM ends the container at once. Fixtures run a zero stop grace, so by default
     * Home is still draining when the grace ends and the stop falls to `destroy()`.
     */
    sigtermExits: false,
    /**
     * The policy lease the default readiness answer reports. A short one with a slow answer is a
     * ready answer that comes after its lease, as from a container whose answers are late.
     */
    readinessLeaseMs: 1_500,
  };
  // The code the platform serves this object once it resets: its own, until a release deploys one.
  let served = options.code ?? runtimeFixtureCode;
  let endpoint: RuntimeEndpoint;
  // Counts resets, so a call the reset object hadn't answered yet fails as the platform fails it.
  let generation = 0;
  // What the object scheduled for after an answer, such as its reset: it runs once one has left.
  const replies: (() => void)[] = [];
  const ctx = {
    /**
     * Resets the object as the platform does: storage and container stay, and its next event runs
     * a fresh endpoint on the code the platform serves it.
     */
    abort(reason: string) {
      calls.resets.push(reason);
      generation++;
      endpoint = build(served);
    },
    exports: { PoolHomePeer: ({ props }: { props: { source: HomePeerSource } }) => ({ props }) },
    id: { toString: () => target.instanceId },
    storage,
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
    container: {
      signal(signal: number) {
        assert.ok(signal === 9 || signal === 15, `unexpected signal ${signal}`);
        calls.signals.push(signal);
        if (signal === 15 && !hooks.sigtermExits) return;
        running = false;
        for (const stop of stops) stop();
        stops.clear();
      },
      async interceptOutboundHttp(host: string, binding: { props: { source: HomePeerSource } }) {
        calls.interceptions.push({ host, source: binding.props.source });
      },
      async exec(command: string[], options?: { stdout: "pipe"; stderr: "ignore" }) {
        if (command[2] === peerProgram.program) {
          assert.equal(command.length, 4);
          assert.deepEqual(options, { stdout: "pipe", stderr: "ignore" });
          helper.starts++;
          helper.witness = { ...JSON.parse(command[3]!), pid: 7, startTicks: "12345", ready: true };
          return {
            pid: 40001,
            stdout: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(helper.witness) + "\n"));
                controller.close();
              },
            }),
            output: async () => {
              throw new Error("Cannot collect a running helper");
            },
          };
        }
        if (command[2] === peerBootstrapInspectionProgram) {
          assert.deepEqual(command, ["python3", "-c", peerBootstrapInspectionProgram]);
          return {
            output: async () => ({
              exitCode: 0,
              stderr: new Uint8Array(),
              stdout: new TextEncoder().encode(
                JSON.stringify({
                  live: !!helper.witness,
                  ...(helper.witness ? { witness: helper.witness } : {}),
                }),
              ),
            }),
          };
        }
        assert.deepEqual(command, ["python3", "-c", legacyDrainProgram]);
        const connections = await hooks.connections();
        return {
          output: async () => ({
            exitCode: 0,
            stdout: new TextEncoder().encode(
              JSON.stringify({ format: "legacy-drain-v1", connections }),
            ),
            stderr: new Uint8Array(),
          }),
        };
      },
      get running() {
        return running;
      },
      start(value: StartupOptions) {
        calls.start++;
        startup = value;
        running = true;
        bootId = crypto.randomUUID();
      },
      async monitor() {
        if (running)
          await new Promise<void>((resolve, reject) => {
            stops.add(resolve);
            losses.add(reject);
          });
      },
      async destroy() {
        // Like the platform, which sends nothing for a container that isn't running.
        if (!running) return;
        hooks.destroy();
        calls.destroy++;
        running = false;
        for (const stop of stops) stop();
        stops.clear();
      },
      setInactivityTimeout: async () => {
        calls.keepAlive++;
        await hooks.keepAlive();
      },
      getTcpPort(port: number) {
        return {
          fetch: async (input: string | Request, init?: RequestInit) => {
            const request = new Request(input, init),
              url = new URL(request.url);
            if (port === 8318) {
              assert.equal(
                request.headers.get("Authorization"),
                `Bearer ${startup.env.POOL_MANAGEMENT_KEY}`,
              );
              if (url.pathname === "/ready") {
                calls.health++;
                const answered = await hooks.health();
                request.signal.throwIfAborted();
                if (answered) return answered;
                const headers = new Headers({
                  [policyHealthHeader]: String(hooks.readinessLeaseMs),
                });
                if (startup.env.POOL_LAUNCH_GENERATION) {
                  headers.set(launchGenerationHeader, startup.env.POOL_LAUNCH_GENERATION);
                  headers.set(
                    launchTokenHashHeader,
                    await launchTokenHash(startup.env.POOL_LAUNCH_TOKEN!),
                  );
                }
                return Response.json(
                  { boot_id: bootId, started_at: "fixture-started" },
                  { headers },
                );
              }
              if (url.pathname === "/native-policy") {
                const { projection } = Schema.decodeUnknownSync(
                  Schema.Struct({ projection: Schema.String }),
                )(await request.json());
                const policy = Schema.decodeUnknownSync(Policy)(
                  await openEnvelope(startup.env.POOL_APP_SIGNING_KEY!, policyPrefix, projection),
                );
                await hooks.install(policy);
                const previous = policies.get(policy.pool);
                assert.ok(!previous || previous.revision <= policy.revision);
                policies.set(policy.pool, policy);
                calls.install.push(policy);
                return Response.json({ installed: true, revision: policy.revision });
              }
              assert.equal(url.pathname, "/native-policy/check");
              const { assertion } = Schema.decodeUnknownSync(
                Schema.Struct({ assertion: Schema.String }),
              )(await request.json());
              const value = Schema.decodeUnknownSync(Assertion)(
                await openEnvelope(startup.env.POOL_APP_SIGNING_KEY!, policyUsePrefix, assertion),
              );
              const policy = policies.get(value.pool);
              return Response.json({
                ok:
                  !!policy &&
                  !policy.dirty &&
                  policy.revision === value.revision &&
                  value.expiresAt > Date.now(),
              });
            }
            if (port === 8327) {
              calls.home++;
              assert.equal(
                request.headers.get("X-Management-Key"),
                startup.env.POOL_MANAGEMENT_KEY,
              );
              return home.fetch(url.pathname + url.search, {
                method: request.method,
                headers: request.headers,
                signal: request.signal,
                ...(request.body ? { body: await request.text() } : {}),
              });
            }
            assert.equal(port, 8317);
            calls.model++;
            return (await hooks.model(request)) ?? Response.json({ data: [{ id: bootId }] });
          },
        };
      },
    },
  };
  const build = (code: ControllerCode) =>
    new RuntimeEndpoint(ctx, env, options.role ?? "runtime", code, nativeResponse, {
      controlPair: nativeControlPair,
      ownStorage: storage,
      afterReply: (work) => {
        replies.push(work);
      },
      ...options.endpoint,
    });
  endpoint = build(served);
  const first = endpoint;
  return {
    ctx,
    env,
    target,
    home,
    calls,
    hooks,
    policies,
    helper,
    /** The object's first endpoint; a reset replaces the one requests reach, not this. */
    endpoint: first,
    wrap: nativeResponse,
    storage,
    identity: (): SlotIdentity => ({ ...target, bootId }),
    digest: () =>
      configurationDigest(
        runtimeConfiguration({
          ...env,
          ...(target.homePeerOrdinal !== undefined
            ? { POOL_HOME_PEER_ORDINAL: String(target.homePeerOrdinal) }
            : {}),
        }),
      ),
    stub: {
      fetch: async (request: Request) => {
        const before = generation;
        const response = await runtimeRequest(request, endpoint);
        if (generation !== before) throw new Error("synthetic object reset");
        for (const work of replies.splice(0)) work();
        return response;
      },
    },
    /** A release: an object the platform resets from now on comes back on `code`. */
    deploy: (code: ControllerCode) => {
      served = code;
    },
    settle: async () => {
      for (let index = 0; index < background.length; index++) await background[index];
    },
    cleanup: async () => {
      for (let index = 0; index < background.length; index++) await background[index];
      await storage.close();
    },
    signingKey,
    crash: () => {
      running = false;
    },
    /**
     * Every held monitor rejects with an error that is no exit while the container process runs on.
     * Like the platform's runtime, whose own monitor sets `running` false on any settle, `running`
     * reads false after it unless a test holds it true to isolate the monitor's outcome.
     */
    loseMonitor: (error: unknown, { runningStays = false } = {}) => {
      if (!runningStays) running = false;
      for (const lose of losses) lose(error);
      losses.clear();
      stops.clear();
    },
    // The same container process reads as running again: same boot, same launch settings.
    revive: () => {
      running = true;
    },
    replaceBoot: () => {
      bootId = crypto.randomUUID();
    },
  };
}
