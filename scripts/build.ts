import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import { bundlePoolApp } from "./pool-app-bundle.ts";

const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
bundlePoolApp(fileURLToPath(new URL("../", import.meta.url)), upstream);
run("node", ["scripts/setup-build.ts"]);
run("bun", ["run", "apps:build"], upstream);
run("node", ["scripts/build-basalt-framework.ts"], upstream);
run("node", ["scripts/framework-registry-build.ts"]);
run("node", ["scripts/framework-provenance.ts"]);
run(
  "node",
  [
    "--test",
    // The suite default the owned unit suite uses; a hung framework proof fails instead of stalling.
    "--test-timeout=60000",
    "scripts/upstream-tests/compiler-preview-acceptance.build-proof.ts",
    "scripts/upstream-tests/pool-framework.test.ts",
    "scripts/upstream-tests/framework-runner-provenance.build-proof.ts",
    "scripts/upstream-tests/framework-registry-runner.build-proof.ts",
    "scripts/upstream-tests/closed-retained-serving.build-proof.ts",
    "scripts/upstream-tests/framework-facet-provenance.build-proof.ts",
    "scripts/upstream-tests/framework-workflow-provenance.build-proof.ts",
  ],
  undefined,
  {
    ...process.env,
    BASALT_CHECK_BUILT_FRAMEWORK: "1",
  },
);
run("bun", ["run", "--cwd", "apps/hosted/cloud", "framework:build"], upstream);
run("node", ["scripts/worker-build.ts"]);
run("bun", ["scripts/pool-worker-build.ts"]);
