import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import { bundlePoolApp } from "./pool-app-bundle.ts";

const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
bundlePoolApp(fileURLToPath(new URL("../", import.meta.url)), upstream);
run("node", ["scripts/setup-build.ts"]);
run("bun", ["run", "apps:build"], upstream);
run("node", ["scripts/build-basalt-framework.ts"], upstream);
run("node", ["--test", "scripts/upstream-tests/pool-framework.test.ts"], undefined, {
  ...process.env,
  BASALT_CHECK_BUILT_FRAMEWORK: "1",
});
run("bun", ["run", "--cwd", "apps/hosted/cloud", "framework:build"], upstream);
run("node", ["scripts/worker-build.ts"]);
run("bun", ["scripts/pool-worker-build.ts"]);
