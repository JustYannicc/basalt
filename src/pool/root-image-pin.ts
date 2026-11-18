import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Schema } from "effect";
import {
  ImmutableImage,
  inDeploymentAccount,
  PoolDeclarationRefused,
  poolImageContext,
} from "./fleet-deployment.ts";
import { euPlacement } from "./placement.ts";

/**
 * The image the legacy root serves, and the build input the controller knows it by. With an `image`
 * prop Alchemy's `hash.image` is a hash of the reference, not of the build, so `input` carries the
 * original build input that POOL_IMAGE_HASH has always named.
 */
export const RootImagePin = Schema.Struct({
  image: ImmutableImage,
  input: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
});

export function decodeRootImagePin(value: string, accountId: string) {
  let pin;
  try {
    pin = Schema.decodeUnknownSync(RootImagePin, { onExcessProperty: "error" })(JSON.parse(value));
  } catch {
    throw new PoolDeclarationRefused({
      reason: "root-image-pin-malformed",
      why: "POOL_ROOT_IMAGE must name one immutable registry digest and its 16-hex build input.",
      fix: 'Set POOL_ROOT_IMAGE to {"image":"registry.cloudflare.com/<account>/<repo>@sha256:<digest>","input":"<16 hex>"} from PoolContainer\'s State row.',
    });
  }
  if (!inDeploymentAccount(pin.image, accountId))
    throw new PoolDeclarationRefused({
      reason: "root-image-pin-other-account",
      why: "The pinned root image is not in the deployment account's registry, so Cloudflare would pull a different image than the root runs.",
      fix: "Pin the image reference recorded on this account's PoolContainer row.",
    });
  return pin;
}

/**
 * Production must pin: a context build there rolls the live root and boots a new Home on its
 * database. Transitional: the old release layer pins the root itself
 * (scripts/release-barrier/legacy-image-plan.ts) and its fixtures evaluate production without a
 * pin, so the native release entry switches the requirement on with POOL_ROOT_IMAGE_REQUIRED.
 * Delete that switch with the barrier; production then always requires the pin.
 */
export const rootImagePin = Effect.gen(function* () {
  const value = yield* Config.String("POOL_ROOT_IMAGE").pipe(Config.withDefault(""));
  const required = yield* Config.Boolean("POOL_ROOT_IMAGE_REQUIRED").pipe(
    Config.withDefault(false),
  );
  if (!value) {
    if (required && (yield* Stage) === "production")
      return yield* Effect.die(
        new PoolDeclarationRefused({
          reason: "root-image-pin-missing",
          why: "Without POOL_ROOT_IMAGE, PoolContainer builds from containers/pool and Alchemy rolls the live root to the new image.",
          fix: "Set POOL_ROOT_IMAGE to the image and hash.image of PoolContainer's State row, as the preflight reads them.",
        }),
      );
    return undefined;
  }
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return decodeRootImagePin(value, accountId);
});

/** The legacy root's container application, pinned by digest when POOL_ROOT_IMAGE is set. */
export const rootContainer = Effect.gen(function* () {
  const pin = yield* rootImagePin;
  const image = Cloudflare.Container("PoolContainer", {
    ...(pin ? { image: pin.image } : { context: poolImageContext }),
    className: "PoolContainer",
    // The snapshot policy rejects placement constraints. EU enforcement takes priority.
    schedulingPolicy: "default",
    instanceType: "basic",
    maxInstances: 1,
    constraints: euPlacement,
    observability: { logs: { enabled: true } },
  });
  const application = yield* image.Application;
  return {
    image,
    application,
    /** POOL_IMAGE_HASH: the identity the controller and Home report for the root. */
    imageHash: pin
      ? pin.input
      : application.hash.pipe(
          Output.map((hash) => {
            if (!hash?.image) throw new Error("The pool image has no build revision");
            return hash.image;
          }),
        ),
    /** The same identity, ordered after the application settles, for readiness and receipts. */
    imageInput: application.hash.pipe(Output.map((hash) => pin?.input ?? hash?.image ?? "")),
  };
});
