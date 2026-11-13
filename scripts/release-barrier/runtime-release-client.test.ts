import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Schema } from "effect";
import { fleetWorkerFixture } from "../pool-tests/runtime-fleet-worker.ts";
import { runtimeApplicationFixture } from "../pool-tests/runtime-provider-fixture.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";
import { runtimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import {
  runtimeHandoffCommandPrefix,
  decodeRuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { RuntimeReleaseState } from "./runtime-release-state.ts";
import { runtimeReleaseClient } from "./runtime-release-client.ts";
import { ordinaryReleaseWriter } from "./runtime-release-writer.ts";
import { decodeApplication } from "./container-observation.ts";

async function fixture(fault?: "stage" | "promote" | "public") {
  const f = await fleetWorkerFixture({ candidateColor: "green", publicProbe: true });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "enable",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  let root = f.worker,
    fail = fault;
  const commands: string[] = [];
  let closes = 0;
  const accountId = f.applications[0]!.accountId;
  const stored = (
    resource: string,
    raw: ReturnType<typeof runtimeApplicationFixture>,
    inputHash: string,
  ) => {
    const attributes = decodeApplication(raw);
    const image = attributes.configuration.image;
    const digest = image.split("@")[1]!;
    return {
      resource,
      attributes: { ...attributes, hash: { image: inputHash, digest } },
      image: { image, inputHash, digest, applicationId: attributes.applicationId },
      instanceId: "1".repeat(32),
      props: {},
    };
  };
  const applications: Record<string, ReturnType<typeof stored>> = {
    root: stored("PoolContainer", runtimeApplicationFixture(f.old.target), f.old.target.imageInput),
  };
  for (const app of f.applications) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications/${app.applicationId}`,
      { method: "GET", headers: { authorization: "Bearer synthetic-provider-read" } },
    );
    const raw = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
      await response.json(),
    ).result;
    const attributes = decodeApplication(raw);
    applications[app.color] = {
      resource: app.color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
      attributes: { ...attributes, hash: { image: app.imageInput, digest: app.imageDigest } },
      image: {
        image: attributes.configuration.image,
        inputHash: app.imageInput,
        digest: app.imageDigest,
        applicationId: app.applicationId,
      },
      instanceId: app.color.repeat(8),
      props: {},
    };
  }
  const state = Schema.decodeUnknownSync(RuntimeReleaseState)({
    target: { accountId, worker: "synthetic-pool" },
    applications,
    configuration: runtimeConfiguration(f.old.env),
    deploymentKey: f.old.env.POOL_DEPLOYMENT_KEY,
  });
  const writer = ordinaryReleaseWriter({
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_JOB: "deploy",
    GITHUB_REPOSITORY: "JustYannicc/basalt",
    GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/deploy.yml@refs/heads/main",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    BASALT_RELEASE_CANDIDATE: runtimeFixtureCode.candidate,
    ALCHEMY_STAGE: "production",
  });
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-provider-read" } }),
          ),
        ),
      ),
    );
  const client = await run(
    runtimeReleaseClient({
      state,
      code: runtimeFixtureCode,
      writer,
      desiredConfiguration: runtimeConfiguration(f.candidate.env),
      target: {
        ...state.target,
        connect: async () => ({
          env: {
            POOL_OPERATIONS: {
              fetch: async (request) => {
                const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
                  await request.clone().json(),
                );
                const command = decodeRuntimeHandoffCommand(
                  await openEnvelope(
                    state.deploymentKey,
                    runtimeHandoffCommandPrefix,
                    body.envelope,
                  ),
                );
                commands.push(command.action);
                const response = await root.runtimeHandoff(request);
                if (fail === command.action) {
                  fail = undefined;
                  throw new Error("synthetic lost committed reply");
                }
                return response;
              },
            },
          },
          dispose: async () => {
            closes++;
          },
        }),
      },
    }),
  );
  if (fault === "public") f.onPublicProbe(async () => new Response(null, { status: 503 }));
  return {
    ...f,
    client,
    commands,
    closes: () => closes,
    reconstructRoot: () => {
      root = f.reconstruct();
    },
  };
}

test(
  "the ordinary release client stages, joins real provider reads, proves public serving and promotes once",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reading: Promise<string> | undefined;
    context.after(async () => {
      try {
        body?.close();
      } catch {}
      await reading?.catch(() => {});
      await f.cleanup();
    });
    f.onModel(async (_runtime, request) =>
      new URL(request.url).searchParams.has("held")
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                controller.enqueue(new TextEncoder().encode("old:"));
              },
            }),
          )
        : undefined,
    );
    const old = await f.model(new Request("https://pool.invalid/v1/models?held=1"));
    reading = old.text();
    await f.client.promote("green-application", "ordinary-release", f.claims.pool);
    assert.equal(f.publicProbeReads(), 1);
    assert.equal(f.probeKeys.keys.length, 0);
    assert.equal(f.commands.filter((action) => action === "stage").length, 1);
    assert.equal(f.commands.filter((action) => action === "promote").length, 1);
    assert.equal(
      (await f.client.inspect()).selection!.active.target.applicationId,
      "green-application",
    );
    assert.equal(
      await f.client.selectedCurrent(
        f.candidate.target.imageInput,
        runtimeConfiguration(f.candidate.env),
      ),
      true,
    );
    assert.equal(
      await f.client.selectedCurrent(f.candidate.target.imageInput, {
        ...runtimeConfiguration(f.candidate.env),
        managementKey: "other-synthetic-key",
      }),
      false,
    );
    assert.equal(f.old.calls.destroy, 0);
    body!.enqueue(new TextEncoder().encode("terminal"));
    body!.close();
    assert.equal(await reading, "old:terminal");
    f.reconstructRoot();
    assert.ok(await f.client.health());
    assert.equal(f.closes(), f.commands.length);
  },
);

test(
  "a refused public candidate read keeps the old selected runtime serving",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture("public");
    context.after(() => f.cleanup());
    await assert.rejects(
      f.client.promote("green-application", "public-refused", f.claims.pool),
      /runtime-handoff-response-refused/,
    );
    assert.equal(f.commands.filter((action) => action === "promote").length, 0);
    assert.equal(f.publicProbeReads(), 1);
    assert.equal(
      (await f.client.inspect()).selection!.active.identity!.bootId,
      f.old.identity().bootId,
    );
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(f.probeKeys.keys.length, 0);
  },
);

test(
  "successive ordinary handoffs alternate applications and preserve the previously selected runtime's held response",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reading: Promise<string> | undefined;
    context.after(async () => {
      try {
        body?.close();
      } catch {}
      await reading?.catch(() => {});
      await f.cleanup();
    });
    await f.client.promote("green-application", "first-ordinary-release", f.claims.pool);
    await f.send("drain", { operationId: "drain-original-primary" });
    assert.equal((await f.client.inspect()).selection?.draining, undefined);
    assert.equal(f.old.calls.destroy, 1);
    const green = [...f.instances.values()].find((instance) => instance.color === "green")!;
    f.onModel(async (_runtime, request) =>
      new URL(request.url).searchParams.has("held")
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                controller.enqueue(new TextEncoder().encode("green:"));
              },
            }),
          )
        : undefined,
    );
    const held = await f.model(new Request("https://pool.invalid/v1/models?held=1"));
    reading = held.text();
    await f.client.promote("blue-application", "second-ordinary-release", f.claims.pool);
    assert.equal(
      (await f.client.inspect()).selection!.active.target.applicationId,
      "blue-application",
    );
    assert.equal(green.fixture.calls.destroy, 0);
    f.reconstructRoot();
    assert.ok(await f.client.health());
    body!.enqueue(new TextEncoder().encode("terminal"));
    body!.close();
    assert.equal(await reading, "green:terminal");
    await f.settle();
    await f.send("drain", { operationId: "drain-green-primary" });
    assert.equal(green.fixture.calls.destroy, 1);
    assert.equal((await f.client.inspect()).selection?.draining, undefined);
    assert.equal(f.commands.filter((action) => action === "stage").length, 2);
    assert.equal(f.commands.filter((action) => action === "promote").length, 2);
    assert.equal(f.publicProbeReads(), 2);
    assert.equal(f.probeKeys.keys.length, 0);
  },
);

for (const fault of ["stage", "promote"] as const)
  test(
    `a lost ${fault} reply reconstructs and reads the committed state without repeating that mutation`,
    { timeout: 15_000 },
    async (context) => {
      const f = await fixture(fault);
      context.after(() => f.cleanup());
      await assert.rejects(
        f.client.promote("green-application", "lost-reply", f.claims.pool),
        /synthetic lost committed reply/,
      );
      f.reconstructRoot();
      await f.client.promote("green-application", "lost-reply", f.claims.pool);
      assert.equal(f.commands.filter((action) => action === "stage").length, 1);
      assert.equal(f.commands.filter((action) => action === "promote").length, 1);
      assert.equal(f.publicProbeReads(), 1);
      assert.equal(f.instances.size, 1);
      assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
      assert.equal(
        (await f.client.inspect()).selection!.active.target.applicationId,
        "green-application",
      );
      assert.equal(f.closes(), f.commands.length);
    },
  );
