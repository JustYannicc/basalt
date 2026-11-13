import assert from "node:assert/strict";
import { ConfigProvider, Effect, Schema } from "effect";
import { fleetWorkerFixture } from "../../pool-tests/runtime-fleet-worker.ts";
import { runtimeApplicationFixture } from "../../pool-tests/runtime-provider-fixture.ts";
import { runtimeFixtureCode } from "../../pool-tests/runtime-handoff-proofs.ts";
import { runtimeConfiguration } from "../../../src/pool/runtime-slots/configuration.ts";
import {
  runtimeHandoffCommandPrefix,
  decodeRuntimeHandoffCommand,
} from "../../../src/pool/runtime-slots/handoff-command.ts";
import { openEnvelope } from "../../../src/pool/token.ts";
import { RuntimeReleaseState } from "../runtime-release-state.ts";
import { runtimeReleaseClient } from "../runtime-release-client.ts";
import { ordinaryReleaseWriter } from "../runtime-release-writer.ts";
import { decodeApplication } from "../container-observation.ts";
import type { ReleasePromotionAttempt } from "../runtime-release-promotion.ts";
import { SlotRefused } from "../../../src/pool/runtime-slots/contract.ts";

export async function runtimeReleaseClientFixture(
  fault?:
    | "stage"
    | "promote"
    | "public"
    | "candidate-probe"
    | "candidate-probe-before"
    | "promote-before"
    | "promote-refuse",
) {
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
  let promotion: ReleasePromotionAttempt | undefined;
  const attempts: ReleasePromotionAttempt[] = [];
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
      promotion: {
        read: async () => promotion,
        write: async (next) => {
          promotion = structuredClone(next);
          attempts.push(structuredClone(next));
        },
      },
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
                if (command.action === "candidate-probe") assert.equal(promotion?.probeSent, true);
                if (command.action === "promote") assert.equal(promotion?.promotionSent, true);
                if (fail === `${command.action}-before`) {
                  fail = undefined;
                  throw new Error("synthetic unknown send before receipt");
                }
                if (fail === "promote-refuse" && command.action === "promote") {
                  fail = undefined;
                  let health = 0;
                  const runtime = [...f.instances.values()][0]!.fixture;
                  runtime.hooks.health = async () => {
                    // The first health belongs to attestation; refusal follows the durable promotion intent.
                    if (++health === 2) throw new SlotRefused("unhealthy");
                  };
                }
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
    state,
    client,
    commands,
    attempts,
    closes: () => closes,
    reconstructRoot: () => {
      root = f.reconstruct();
    },
  };
}
