import { readFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { Effect, Layer } from "effect";
import { desiredPoolImageInput } from "../../src/pool/image-release-plan.ts";
import { waitForPoolImage } from "./pool-image.ts";
import { requireCloudflareEnvironment } from "./runtime.ts";
import { brand } from "../../brand.ts";

const path = process.env.BASALT_POOL_IMAGE_RECEIPT;
if (!path) throw new Error("Pool publication receipt path is missing");
const receipt = JSON.parse(readFileSync(path, "utf8"));
const candidate = process.env.GITHUB_SHA ?? "";
// Computed from this candidate's own pool image source with the same function the deploy uses, so a
// fleet serving any other image cannot pass as this release.
const candidateImageInput = await Effect.runPromise(
  desiredPoolImageInput.pipe(
    Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
const result = await waitForPoolImage(
  receipt,
  candidate,
  requireCloudflareEnvironment(),
  `https://${brand.host}`,
  fetch,
  { candidateImageInput },
);
console.log(
  JSON.stringify({
    poolImageVerified: {
      candidate: result.candidate,
      platform: result.platform,
      inputHash: result.inputHash,
      digest: result.digest,
      configDigest: result.configDigest,
      capabilityLabel: result.capabilityLabel,
      verifiedPath: result.verifiedPath,
      candidateImageInput,
      // A retired root has no instances; fleet instances run their own configured digests.
      ...(result.fleet
        ? {
            fleet: result.fleet.map((app) => ({
              color: app.color,
              imageInput: app.imageInput,
              digest: app.digest,
              activeInstances: app.instances.length,
            })),
          }
        : { activeInstances: result.instances.length }),
    },
  }),
);
