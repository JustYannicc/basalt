import { fileURLToPath } from "node:url";
import { deployEnvironment } from "./environment.ts";
import { appHosting } from "../brand.ts";
import { run } from "./process.ts";

const environment = deployEnvironment();
const cloud = fileURLToPath(new URL("../.upstream/apps/hosted/cloud/", import.meta.url));
if (appHosting.enabled) {
  run(
    "bun",
    ["exec", "alchemy", "deploy", "alchemy.app-domains.ts", "--stage", "shared", "--yes"],
    cloud,
    environment,
  );
}
run(
  "bun",
  [
    "exec",
    "alchemy",
    "deploy",
    "../../../../alchemy.run.ts",
    "--stage",
    environment.ALCHEMY_STAGE!,
    "--yes",
  ],
  cloud,
  environment,
);
