import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
run("bun", ["run", "apps:build"], upstream);
run("bun", ["run", "--cwd", "apps/hosted/cloud", "framework:build"], upstream);
run("node", ["scripts/worker-build.ts"]);
