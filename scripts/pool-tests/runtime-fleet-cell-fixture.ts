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
import { SlotRefused } from "../../src/pool/runtime-slots/contract.ts";

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
    failRuntime = false;
  let credential: string | null = "synthetic-provider-token";
  let ran = false;
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
        ? ran
          ? [
              {
                id: target.instanceId,
                application_id: target.applicationId,
                image: providerFixture.raw.configuration.image,
                status: { state: running ? "running" : "inactive" },
              },
            ]
          : []
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
  };
  const makeCell = () =>
    boundFleetCell({
      ctx: root,
      env,
      target,
      code: runtimeFixtureCode,
      provider,
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
            const refused = transport.refuse[new URL(request.url).pathname];
            if (refused) {
              await request.text();
              return runtimeErrorResponse(new SlotRefused(refused), "endpoint");
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
    // The same cell over the same storage, as the controller's replaced isolate builds it.
    replacedCell: makeCell,
    ...runtime,
    cell,
    storage,
    transport,
    secret: (value: string | null) => {
      credential = value;
    },
    failApplication: (value: boolean) => {
      failApplication = value;
    },
    failRuntime: (value: boolean) => {
      failRuntime = value;
    },
    cleanup: async () => {
      await Promise.all(background);
      await storage.close();
      await runtime.cleanup();
    },
  };
}
