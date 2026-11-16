import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { euPlacement } from "./placement.ts";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema } from "effect";
import { RuntimeImageReleasePlan } from "./image-release-plan.ts";
import { fileURLToPath } from "node:url";

const Image = Schema.String.check(
  Schema.isPattern(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u),
);
export const FleetDeploymentImages = Schema.Struct({ blue: Image, green: Image });
const LegacyProps = Schema.Struct({
  isExternal: Schema.optionalKey(Schema.Literal(true)),
  name: Schema.String,
  className: Schema.Literal("PoolRuntime"),
  image: Image,
  instanceType: Schema.Literal("basic"),
  instances: Schema.Literal(0),
  maxInstances: Schema.Literal(1),
  schedulingPolicy: Schema.Literal("default"),
  constraints: Schema.Struct({
    jurisdiction: Schema.Literal("eu"),
    regions: Schema.Tuple([Schema.Literal("EEUR"), Schema.Literal("WEUR")]),
  }),
  observability: Schema.Struct({ logs: Schema.Struct({ enabled: Schema.Literal(true) }) }),
});

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
  const plan = yield* RuntimeImageReleasePlan;
  if (!plan && !input) return undefined;
  const stage = yield* Stage;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const legacyImage = plan?.legacy;
  const legacyProps = legacyImage
    ? Schema.decodeUnknownSync(LegacyProps, { onExcessProperty: "error" })(legacyImage.props)
    : undefined;
  if (
    legacyProps &&
    (legacyProps.image !== legacyImage!.image ||
      !legacyProps.image.startsWith(`registry.cloudflare.com/${accountId}/`))
  )
    throw new Error(
      "Retained PoolRuntime image does not match its deployment account and native provenance",
    );
  const images = plan?.images ?? decodeFleetDeploymentImages(input, accountId);
  if (!Object.keys(images).length && !legacyProps) return undefined;
  if (plan?.build && !images[plan.build])
    throw new Error("Candidate image application is missing from the release plan");
  for (const image of Object.values(images)) {
    Schema.decodeUnknownSync(Image)(image);
    if (!image.startsWith(`registry.cloudflare.com/${accountId}/`))
      throw new Error("Fleet image belongs to another deployment account");
  }
  const declare = (color: "blue" | "green") =>
    Cloudflare.Container(color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen", {
      name: `basalt-${stage}-pool-runtime-${color}`,
      className: color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
      ...(plan?.build === color
        ? { context: fileURLToPath(new URL("../../containers/pool/", import.meta.url)) }
        : { image: images[color]! }),
      instanceType: "basic",
      instances: 0,
      maxInstances: 4,
      schedulingPolicy: "default",
      constraints: euPlacement,
      observability: { logs: { enabled: true } },
    });
  const blue = images.blue ? declare("blue") : undefined,
    green = images.green ? declare("green") : undefined;
  const legacy = legacyProps
    ? Cloudflare.Container("PoolRuntime", { ...legacyProps, constraints: euPlacement })
    : undefined;
  const legacyApplication = legacy ? yield* legacy.Application.pipe(retain()) : undefined;
  const blueApplication = blue ? yield* blue.Application.pipe(retain()) : undefined;
  const greenApplication = green ? yield* green.Application.pipe(retain()) : undefined;
  const imageInput = (application: NonNullable<typeof blueApplication>) =>
    application.hash.pipe(
      Output.map((hash) => {
        if (!hash?.image) throw new Error("Fleet application has no image input");
        return hash.image;
      }),
    );
  return {
    ...(legacy ? { PoolRuntime: legacy } : {}),
    ...(blue && blueApplication
      ? {
          PoolRuntimeBlue: blue,
          POOL_BLUE_APPLICATION_ID: blueApplication.applicationId,
          POOL_BLUE_IMAGE_HASH: imageInput(blueApplication),
        }
      : {}),
    ...(green && greenApplication
      ? {
          PoolRuntimeGreen: green,
          POOL_GREEN_APPLICATION_ID: greenApplication.applicationId,
          POOL_GREEN_IMAGE_HASH: imageInput(greenApplication),
        }
      : {}),
    POOL_RUNTIME_APPLICATION_ID: (legacyApplication ?? blueApplication ?? greenApplication)!
      .applicationId,
  };
});
