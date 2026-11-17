import { readFileSync } from "node:fs";
import { waitForPoolImage } from "./pool-image.ts";
import { requireCloudflareEnvironment } from "./runtime.ts";
import { brand } from "../../brand.ts";

const path = process.env.BASALT_POOL_IMAGE_RECEIPT;
if (!path) throw new Error("Pool publication receipt path is missing");
const receipt = JSON.parse(readFileSync(path, "utf8"));
const candidate = process.env.GITHUB_SHA ?? "";
const result = await waitForPoolImage(
  receipt,
  candidate,
  requireCloudflareEnvironment(),
  `https://${brand.host}`,
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
