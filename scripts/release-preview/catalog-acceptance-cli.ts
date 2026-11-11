import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { previewConfigFromEnvironment } from "../pool-acceptance/preview-config.ts";
import { compilerPreviewEnvironment } from "./policy.ts";
import { requireSuccessfulCatalogAcceptance } from "./catalog-acceptance-receipt.ts";
import { runCatalogAcceptance } from "./catalog-acceptance.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const environment = compilerPreviewEnvironment(process.env, process.env.ALCHEMY_STAGE ?? "");
    const head = environment.BASALT_RELEASE_CANDIDATE;
    const output = process.env.PREVIEW_CATALOG_ACCEPTANCE_RESULT;
    if (environment.EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE !== "true" || !head || !output)
      throw new Error("Missing explicit compiler preview acceptance inputs");
    const result = await runCatalogAcceptance(await previewConfigFromEnvironment(), head, output);
    requireSuccessfulCatalogAcceptance(result, head);
    console.log("All 33 preview catalog installs and owned-app cleanup passed");
  } catch {
    console.error("Preview catalog acceptance failed; inspect its safe per-app result");
    process.exitCode = 1;
  }
}
