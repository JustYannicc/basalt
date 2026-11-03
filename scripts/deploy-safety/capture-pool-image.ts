import { writeFileSync } from "node:fs";
import { poolImageReceipt } from "./pool-image.ts";

// A capture failure belongs to the image assertion, which stops without an automatic rollback.
try {
  const source = process.env;
  const receipt = {
    candidate: source.GITHUB_SHA,
    applicationId: source.POOL_APPLICATION_ID,
    accountId: source.CLOUDFLARE_ACCOUNT_ID,
    workerName: source.POOL_WORKER_READY,
    inputHash: source.POOL_IMAGE_INPUT_HASH,
    digest: source.POOL_IMAGE_DIGEST,
    platform: "linux/amd64",
    capability: "oauth-completion-receipts-v1",
  };
  poolImageReceipt(receipt, source.GITHUB_SHA ?? "");
  if (!source.BASALT_POOL_IMAGE_RECEIPT) throw new Error("Missing output path");
  writeFileSync(source.BASALT_POOL_IMAGE_RECEIPT, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
} catch {
  console.error("Pool publication receipt was not captured; the release image assertion will refuse success");
}
