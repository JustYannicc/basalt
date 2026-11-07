import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertReadOnlyPlanContext, readOnlyPlanEnvironment } from "./read-only-runtime.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assertReadOnlyPlanContext(process.env, candidate);
const env = readOnlyPlanEnvironment(process.env, root);
const result = spawnSync("bun", [fileURLToPath(new URL("./read-only-entry.ts", import.meta.url))], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (result.error) throw new Error("Could not start the read-only release plan");
process.exitCode = result.status ?? 1;
