import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { poolImageReceipt } from "./pool-image.ts";
import { inspectPoolImage } from "./pool-image-metadata.ts";
import type { Fetcher } from "./http.ts";

export async function capturePoolImage(source: NodeJS.ProcessEnv, fetcher: Fetcher = fetch) {
  const metadata = await inspectPoolImage(source.POOL_IMAGE_REF ?? "", source.POOL_IMAGE_DIGEST ?? "", {
    accountId: source.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: source.CLOUDFLARE_API_TOKEN ?? "",
  }, fetcher);
  const receipt = {
    candidate: source.GITHUB_SHA,
    applicationId: source.POOL_APPLICATION_ID,
    accountId: source.CLOUDFLARE_ACCOUNT_ID,
    workerName: source.POOL_WORKER_READY,
    inputHash: source.POOL_IMAGE_INPUT_HASH,
    ...metadata,
  };
  poolImageReceipt(receipt, source.GITHUB_SHA ?? "");
  if (!source.BASALT_POOL_IMAGE_RECEIPT) throw new Error("Missing output path");
  writeFileSync(source.BASALT_POOL_IMAGE_RECEIPT, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await capturePoolImage(process.env);
}
