import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { euPlacement } from "./placement.ts";
import { Stage } from "alchemy/Stage";
import { Config, Data, Effect, Schema } from "effect";
import type { RuntimeColor } from "./image-release-plan.ts";
import { fileURLToPath } from "node:url";

/** A pool declaration that would change the live pool in a way no deploy may: why, and what to set. */
export class PoolDeclarationRefused extends Data.TaggedError("PoolDeclarationRefused")<{
  readonly reason: string;
  readonly why: string;
  readonly fix: string;
}> {
  override get message() {
    return `${this.reason}: ${this.why} Fix: ${this.fix}`;
  }
}

/** The build every pool runtime image comes from. */
export const poolImageContext = fileURLToPath(new URL("../../containers/pool/", import.meta.url));

export const ImmutableImage = Schema.String.check(
  Schema.isPattern(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u),
);
const Image = ImmutableImage;
export const inDeploymentAccount = (image: string, accountId: string) =>
  image.startsWith(`registry.cloudflare.com/${accountId}/`);
export const FleetDeploymentImages = Schema.Struct({ blue: Image, green: Image });

/**
 * "absent" leaves PoolRuntimeBlue/Green out of PoolWorker entirely, for the code-only release that
 * precedes the class change. It is only valid while the classes do not exist yet: once declared,
 * dropping them is a `deleted_classes` migration, which the plan check and the deploy wire guard
 * refuse. Delete this switch after the cutover.
 */
export const fleetClasses = Config.Literals(["declared", "absent"], "POOL_FLEET_CLASSES").pipe(
  Config.withDefault("declared"),
);
export type FleetClasses = "declared" | "absent";

export function decodeFleetDeploymentImages(value: string, accountId: string) {
  try {
    const images = Schema.decodeUnknownSync(FleetDeploymentImages, { onExcessProperty: "error" })(
      JSON.parse(value),
    );
    if (Object.values(images).some((image) => !inDeploymentAccount(image, accountId)))
      throw new Error();
    return images;
  } catch {
    throw new Error("Fleet images must be immutable references in the deployment account");
  }
}

/**
 * PoolWorker always hosts both fleet classes, so its alchemy deploy is the one writer of their
 * migrations. A color without an image is a plain SQLite class; when its Container replaces this
 * binding under the same env key, the logical id and class are unchanged and no migration is sent.
 * Never drop these: alchemy would compute `deleted_classes` for a class its tags still name.
 * `classes: "absent"` (see {@link fleetClasses}) is the one pre-cutover exception.
 */
export const fleetBindings = <Fleet extends object>(
  fleet: Fleet | undefined,
  classes: FleetClasses = "declared",
) =>
  classes === "absent"
    ? {}
    : {
        PoolRuntimeBlue: Cloudflare.DurableObject("PoolRuntimeBlue", {
          className: "PoolRuntimeBlue",
        }),
        PoolRuntimeGreen: Cloudflare.DurableObject("PoolRuntimeGreen", {
          className: "PoolRuntimeGreen",
        }),
        ...fleet,
      };

/** The Durable Object class, and Alchemy resource, that hosts a fleet color. */
export const fleetClassName = (color: RuntimeColor) =>
  color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen";

/** Image pins declare infrastructure; only a separate signed fleet command grants launch permission. */
export const fleetInfrastructure = Effect.gen(function* () {
  const input = yield* Config.String("POOL_FLEET_IMAGES").pipe(Config.withDefault(""));
  // Alchemy builds both colours from the pool image context, so a plain deploy creates them.
  const build = yield* Config.Boolean("POOL_FLEET_BUILD").pipe(Config.withDefault(false));
  const classes = yield* fleetClasses;
  if (classes === "absent") {
    if (input || build)
      return yield* Effect.die(
        new PoolDeclarationRefused({
          reason: "fleet-classes-absent-with-fleet",
          why: "POOL_FLEET_CLASSES=absent declares no PoolRuntimeBlue or PoolRuntimeGreen class, so no fleet application has a class to run in.",
          fix: "Unset POOL_FLEET_BUILD and POOL_FLEET_IMAGES, or set POOL_FLEET_CLASSES=declared.",
        }),
      );
    return undefined;
  }
  if (build && input)
    return yield* Effect.die(
      new PoolDeclarationRefused({
        reason: "fleet-build-with-images",
        why: "POOL_FLEET_BUILD builds both colours from containers/pool, while POOL_FLEET_IMAGES pins them to published images. One deploy cannot do both.",
        fix: "Set either POOL_FLEET_BUILD=true or POOL_FLEET_IMAGES, not both.",
      }),
    );
  if (!input && !build) return undefined;
  const stage = yield* Stage;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const images: Partial<Record<RuntimeColor, string>> = build
    ? {}
    : decodeFleetDeploymentImages(input, accountId);
  const declare = (color: "blue" | "green") =>
    Cloudflare.Container(fleetClassName(color), {
      name: `basalt-${stage}-pool-runtime-${color}`,
      className: fleetClassName(color),
      ...(build ? { context: poolImageContext } : { image: images[color]! }),
      instanceType: "basic",
      instances: 0,
      maxInstances: 4,
      schedulingPolicy: "default",
      constraints: euPlacement,
      observability: { logs: { enabled: true } },
    });
  const blue = build || images.blue ? declare("blue") : undefined,
    green = build || images.green ? declare("green") : undefined;
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
    POOL_RUNTIME_APPLICATION_ID: (blueApplication ?? greenApplication)!.applicationId,
  };
});
