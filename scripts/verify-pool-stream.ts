import { brand } from "../brand.ts";
import { verifyOptionalModelStream } from "./model-stream.ts";

await verifyOptionalModelStream({
  key: process.env.POOL_ACCEPTANCE_KEY,
  model: process.env.POOL_ACCEPTANCE_MODEL,
  summary: process.env.GITHUB_STEP_SUMMARY,
  origin: `https://${brand.host}`,
});
