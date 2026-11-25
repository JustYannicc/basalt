import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
run("node", ["scripts/check-git-secrets.ts"], root);
run("node", ["e2e/check-boundary.ts"], upstream);
run("node", ["scripts/ci/style.ts"], root);
// Basalt's own rules over scripts/ and src/, against a baseline that only shrinks.
run("node", ["scripts/owned-lint/check.ts"], root);
run("bun", ["run", "mcp:apps", "--check"], upstream);
run("node", ["scripts/check-connectors.ts", "--preflight"], root);
// The pool typecheck reads the shipped authoring declarations, just like the production gate.
run("bun", ["run", "apps:build"], upstream);
run("node", ["scripts/typecheck.ts"], root);
// The type check records Effect diagnostics; this holds Basalt's code to their baseline.
run("node", ["scripts/effect-diagnostics.ts"], root);
