import { run } from "./process.ts";
const compiler = ".upstream/node_modules/.bin/tsc-rs";
run(compiler, ["--noEmit", "-p", "tsconfig.json"]);
run(compiler, ["--noEmit", "-p", "tsconfig.worker.json"]);
