import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { brand } from "../brand.ts";
import { verifyOptionalModelStream } from "./release-barrier/model-stream.ts";

const receipt = process.env.POOL_ACCEPTANCE_KEY?.trim()
  ? await readFile(new URL("../.local/release-barrier/serving.json", import.meta.url), "utf8").then(
      (value) =>
        Schema.decodeUnknownSync(Schema.Struct({ bootId: Schema.String }))(JSON.parse(value)),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw new Error("Serving receipt unreadable");
        return undefined;
      },
    )
  : undefined;
await verifyOptionalModelStream({
  key: process.env.POOL_ACCEPTANCE_KEY,
  expectedBoot: receipt?.bootId,
  model: process.env.POOL_ACCEPTANCE_MODEL,
  summary: process.env.GITHUB_STEP_SUMMARY,
  origin: `https://${brand.host}`,
});
