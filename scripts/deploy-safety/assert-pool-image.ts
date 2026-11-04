import { readFileSync } from "node:fs";
import { waitForPoolImage } from "./pool-image.ts";
import { requireCloudflareEnvironment } from "./runtime.ts";
import { brand } from "../../brand.ts";

const path = process.env.BASALT_POOL_IMAGE_RECEIPT;
if (!path) throw new Error("Pool publication receipt path is missing");
const receipt = JSON.parse(readFileSync(path, "utf8"));
const candidate = process.env.GITHUB_SHA ?? "";
const result = await waitForPoolImage(receipt, candidate, requireCloudflareEnvironment(), `https://${brand.host}`);
console.log(JSON.stringify({ poolImageVerified: {
  candidate: result.candidate, platform: result.platform, inputHash: result.inputHash,
  digest: result.digest, activeInstances: result.instances.length,
  configDigest: result.configDigest, capabilityLabel: result.capabilityLabel,
} }));
