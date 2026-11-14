import { handoffRuntime } from "./runtime-handoff-fixture.ts";
import { RuntimeSqlite } from "./runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "../release-barrier/test/runtime-proof-fixture.ts";
import { boundFleetCell } from "../../src/pool/runtime-fleet/bound-cell.ts";
import { RuntimeProviderReader } from "../../src/pool/runtime-provider/read.ts";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";

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
  const provider = new RuntimeProviderReader({ get: async () => credential }, async (input) => {
    const instances = new URL(input).pathname.endsWith("instances-v2");
    if (instances ? failRuntime : failApplication) return new Response(null, { status: 403 });
    return Response.json({
      success: true,
      errors: [],
      result: instances
        ? runtime.ctx.container.running
          ? [
              {
                id: target.instanceId,
                application_id: target.applicationId,
                image: providerFixture.raw.configuration.image,
                status: { state: "running" },
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
  };
  const cell = boundFleetCell({
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
          if (request.headers.has("X-Signalbox-Runtime-Identity")) transport.modelStubs.push(stub);
          return runtime.stub.fetch(request);
        },
      };
    },
  });
  return {
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
