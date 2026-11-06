import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
run("node", ["e2e/check-boundary.ts"], upstream);
run("node", ["scripts/ci/style.ts"], root);
run("bun", ["run", "mcp:apps", "--check"], upstream);
run("node", ["scripts/check-connectors.ts", "--preflight"], root);
// The pool typecheck reads the shipped authoring declarations, just like the production gate.
run("bun", ["run", "apps:build"], upstream);
run("node", ["scripts/typecheck.ts"], root);
