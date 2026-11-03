import { readFileSync } from "node:fs";
import { assertPoolImage, poolImageReceipt } from "./pool-image.ts";
import { requireCloudflareEnvironment } from "./runtime.ts";
import { waitForPoolStatus } from "../pool-readiness.ts";
import { brand } from "../../brand.ts";

const path = process.env.BASALT_POOL_IMAGE_RECEIPT;
if (!path) throw new Error("Pool publication receipt path is missing");
const receipt = JSON.parse(readFileSync(path, "utf8"));
const candidate = process.env.GITHUB_SHA ?? "";
poolImageReceipt(receipt, candidate);
await waitForPoolStatus("Pool image readiness", 401, (signal) => fetch(`https://${brand.host}/pool/v1/pool`, { redirect: "manual", signal }));
const result = await assertPoolImage(receipt, candidate, requireCloudflareEnvironment());
console.log(JSON.stringify({ poolImageVerified: result }));
