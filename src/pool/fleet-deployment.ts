import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { euPlacement } from "./placement.ts";
import { poolObservationTokenProps } from "./fleet-observation.ts";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema } from "effect";

const Image = Schema.String.check(
  Schema.isPattern(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u),
);
export const FleetDeploymentImages = Schema.Struct({ blue: Image, green: Image });

export function decodeFleetDeploymentImages(value: string, accountId: string) {
  try {
    const images = Schema.decodeUnknownSync(FleetDeploymentImages, { onExcessProperty: "error" })(
      JSON.parse(value),
    );
    if (
      Object.values(images).some(
        (image) => !image.startsWith(`registry.cloudflare.com/${accountId}/`),
      )
    )
      throw new Error();
    return images;
  } catch {
    throw new Error("Fleet images must be immutable references in the deployment account");
  }
}

/** Image pins declare infrastructure; only a separate signed fleet command grants launch permission. */
export const fleetInfrastructure = Effect.gen(function* () {
  const input = yield* Config.String("POOL_FLEET_IMAGES").pipe(Config.withDefault(""));
  if (!input) return undefined;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const stage = yield* Stage;
  const images = decodeFleetDeploymentImages(input, accountId);
  const declare = (color: "blue" | "green") =>
    Cloudflare.Container(color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen", {
      name: `basalt-${stage}-pool-runtime-${color}`,
      className: color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
      image: images[color],
      instanceType: "basic",
      instances: 0,
      maxInstances: 4,
      schedulingPolicy: "default",
      constraints: euPlacement,
      observability: { logs: { enabled: true } },
    });
  const blue = declare("blue"),
    green = declare("green");
  const blueApplication = yield* blue.Application.pipe(retain());
  const greenApplication = yield* green.Application.pipe(retain());
  const observation = yield* Cloudflare.ApiToken.AccountApiToken(
    "PoolProviderObservationToken",
    poolObservationTokenProps(accountId, stage),
  ).pipe(retain());
  const imageInput = (application: typeof blueApplication) =>
    application.hash.pipe(
      Output.map((hash) => {
        if (!hash?.image) throw new Error("Fleet application has no image input");
        return hash.image;
      }),
    );
  return {
    PoolRuntimeBlue: blue,
    PoolRuntimeGreen: green,
    POOL_RUNTIME_APPLICATION_ID: blueApplication.applicationId,
    POOL_BLUE_APPLICATION_ID: blueApplication.applicationId,
    POOL_BLUE_IMAGE_HASH: imageInput(blueApplication),
    POOL_GREEN_APPLICATION_ID: greenApplication.applicationId,
    POOL_GREEN_IMAGE_HASH: imageInput(greenApplication),
    POOL_PROVIDER_OBSERVATION_TOKEN: observation.value,
  };
});
