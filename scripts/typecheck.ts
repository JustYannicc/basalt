import { run } from "./process.ts";
const compiler = ".upstream/node_modules/.bin/tsc-rs";
run(compiler, ["--noEmit", "-p", "tsconfig.json"]);
// Resource declarations use the same module and optional-property semantics as the upstream stack.
run(compiler, ["--noEmit", "-p", "tsconfig.stack.json"]);
run(compiler, ["--noEmit", "-p", "tsconfig.worker.json"]);
// The pool app, against the built framework declarations its authors get. Run after `npm run build`.
run(compiler, ["--noEmit", "-p", "tsconfig.pool.json"]);
