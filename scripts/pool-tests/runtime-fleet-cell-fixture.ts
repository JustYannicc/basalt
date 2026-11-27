import { Effect, Schema } from "effect";
import { handoffRuntime } from "./runtime-handoff-fixture.ts";
import { RuntimeSqlite } from "./runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "../pool-fleet/test/runtime-proof-fixture.ts";
import { boundFleetCell } from "../../src/pool/runtime-fleet/bound-cell.ts";
import { RuntimeProviderReader } from "../../src/pool/runtime-provider/read.ts";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { runtimeErrorResponse } from "../../src/pool/runtime-slots/request-error.ts";
import { SlotRefused, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { runtimeStopTiming } from "../../src/pool/runtime-slots/forced-stop.ts";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";

/** The controller code a release deploys, which differs from the fixture's own in every field. */
export const releasedCode: ControllerCode = {
  candidate: "1".repeat(40),
  workerInput: "2".repeat(64),
};

/**
 * The stop's grace runs the latest fixture's `timing`. It is installed once, here, as the handoff
 * fixture installs its zero one, so building a fixture never replaces a grace a test mocked first.
 */
let timed = { stopGrace: async () => {} };
runtimeStopTiming.stopGrace = () => timed.stopGrace();

export async function fleetCellFixture(
  staleFailure: "flagged" | "plain" | "overloaded" | "non-error" | "http" = "flagged",
) {
  const providerFixture = await runtimeProofFixture();
  const target = { ...providerFixture.manifest.target, homePeerOrdinal: 1 };
  const env = {
    POOL_RUNTIME_APPLICATION_ID: target.applicationId,
    POOL_CONTAINER_APPLICATION_ID: "legacy",
    POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "synthetic-management",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_DEPLOYMENT_KEY: "b".repeat(64),
    POOL_IMAGE_HASH: target.imageInput,
  };
  const runtime = await handoffRuntime(target, env);
  const storage = new RuntimeSqlite(),
    background: Promise<unknown>[] = [];
  const root = {
    id: { toString: () => target.controllerId },
    storage,
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
  let failApplication = false,
    failRuntime = false,
    rollout = false;
  let credential: string | null = "synthetic-provider-token";
  let ran = false;
  // The state the provider lists the cell's instance in, when a test sets one.
  let listed: string | undefined;
  // Another instance of the application in this state, and whether the fleet ledger counts it.
  const sibling = {
    id: "synthetic-sibling",
    state: undefined as string | undefined,
    counted: false,
  };
  const provider = new RuntimeProviderReader({ get: async () => credential }, async (input) => {
    const instances = new URL(input).pathname.endsWith("instances-v2");
    if (instances ? failRuntime : failApplication) return new Response(null, { status: 403 });
    const running = runtime.ctx.container.running;
    ran ||= running;
    return Response.json({
      success: true,
      errors: [],
      // As on production: once destroyed, the instance stays listed under state=active as inactive.
      result: instances
        ? [
            ...(ran
              ? [{ id: target.instanceId, state: listed ?? (running ? "running" : "inactive") }]
              : []),
            ...(sibling.state ? [{ id: sibling.id, state: sibling.state }] : []),
          ].map(({ id, state }) => ({
            id,
            application_id: target.applicationId,
            image: providerFixture.raw.configuration.image,
            status: { state },
          }))
        : // As while Cloudflare rolls out a changed image: the same application with a rollout id.
          rollout
          ? { ...providerFixture.raw, active_rollout_id: "synthetic-rollout" }
          : providerFixture.raw,
      result_info: { next_page_token: "" },
    });
  });
  const application = {
    ...providerFixture.manifest.provider,
    applicationId: target.applicationId,
    applicationVersion: target.applicationVersion,
    imageDigest: target.imageDigest,
    applicationConfigDigest: await providerDigest(
      runtimeApplicationSettings(decodeProviderApplication(providerFixture.raw)),
    ),
  };
  const modelStubs: number[] = [];
  const transport = {
    stubs: 0,
    calls: 0,
    fail: false,
    generation: 0,
    disconnected: 0,
    failHealth: false,
    modelStubs,
    // A control path the endpoint refuses, answered as its own refusals are.
    refuse: {} as Record<string, SlotRefused["reason"]>,
    /**
     * An endpoint still on older code, as for minutes after a release: `fence` decodes
     * `/abandon-start` as the fence alone, as code before its stop flag did; `missing` answers it as
     * an action that code doesn't know; `witness` decodes `/witness` as its target alone, as code
     * before the controller's code was passed did, and so never adopts.
     */
    older: undefined as "fence" | "missing" | "witness" | undefined,
    /** Whether each `/abandon-start` the cell sent asked for the stop, in the order sent. */
    abandons: [] as boolean[],
    /** The control path of each call the cell sent its endpoint, in the order sent. */
    sent: [] as string[],
  };
  /**
   * The stop's grace, on whatever clock the test moves. The handoff fixture runs a zero one; a test
   * that holds or spends a grace sets this instead of replacing the production timing.
   */
  const timing = { stopGrace: async () => {} };
  timed = timing;
  const makeCell = (code: ControllerCode = runtimeFixtureCode) =>
    boundFleetCell({
      ctx: root,
      env,
      target,
      code,
      provider,
      // As the ledger does: the cell's own row, and the sibling's while it has one.
      counted: async () => new Set([target.instanceId, ...(sibling.counted ? [sibling.id] : [])]),
      application: { ...application, color: "blue", imageInput: target.imageInput },
      wrap: runtime.wrap,
      remote: () => {
        const stub = ++transport.stubs;
        const generation = transport.generation;
        return {
          fetch: async (request) => {
            transport.calls++;
            if (transport.fail) throw new Error("native transport failed");
            if (
              generation !== transport.generation ||
              (transport.failHealth && new URL(request.url).pathname === "/health")
            ) {
              transport.disconnected++;
              await request.text();
              if (staleFailure === "http") return new Response(null, { status: 409 });
              if (staleFailure === "non-error") throw "synthetic non-Error failure";
              const error = new Error("synthetic stale endpoint stub");
              if (staleFailure === "flagged")
                Object.assign(error, { disconnected: true, retryable: true });
              if (staleFailure === "overloaded") Object.assign(error, { overloaded: true });
              throw error;
            }
            const path = new URL(request.url).pathname;
            transport.sent.push(path);
            if (path === "/abandon-start")
              transport.abandons.push(
                ((await request.clone().json()) as { stop?: unknown }).stop === true,
              );
            const refused = transport.refuse[path];
            if (refused) {
              await request.text();
              return runtimeErrorResponse(new SlotRefused(refused), "endpoint");
            }
            if (transport.older === "witness" && path === "/witness") {
              // That code's own decode: it must take the newer read, ignoring what it doesn't know.
              const { target } = await Effect.runPromise(
                Schema.decodeUnknownEffect(Schema.Struct({ target: SlotTarget }))(
                  await request.json(),
                ),
              );
              return runtime.stub.fetch(
                new Request(request.url, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ target }),
                }),
              );
            }
            if (
              (transport.older === "fence" || transport.older === "missing") &&
              path === "/abandon-start"
            ) {
              if (transport.older === "missing") {
                await request.text();
                return new Response(null, { status: 404 });
              }
              const { target } = (await request.json()) as { target: unknown };
              return runtime.stub.fetch(
                new Request(request.url, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ target }),
                }),
              );
            }
            if (request.headers.has("X-Signalbox-Runtime-Identity"))
              transport.modelStubs.push(stub);
            return runtime.stub.fetch(request);
          },
        };
      },
    });
  const cell = makeCell();
  return {
    // The same cell over the same storage, as the controller's replaced isolate builds it; with
    // `code`, as one on that code builds it.
    replacedCell: (code?: ControllerCode) => makeCell(code),
    ...runtime,
    cell,
    storage,
    transport,
    timing,
    secret: (value: string | null) => {
      credential = value;
    },
    failApplication: (value: boolean) => {
      failApplication = value;
    },
    failRuntime: (value: boolean) => {
      failRuntime = value;
    },
    rollout: (value: boolean) => {
      rollout = value;
    },
    /**
     * Lists the cell's instance in `state` whatever its container does, as a listing that lags its
     * container can; without one, the listing follows the container again.
     */
    listAs: (state: string | undefined) => {
      listed = state;
    },
    /** Lists another instance in `state`, or none without one; `counted` puts it in the ledger. */
    sibling: (state: string | undefined, counted = false) => {
      Object.assign(sibling, { state, counted });
    },
    cleanup: async () => {
      await Promise.all(background);
      await storage.close();
      await runtime.cleanup();
    },
  };
}
