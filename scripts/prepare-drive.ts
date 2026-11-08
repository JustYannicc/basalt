import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
run("bun", ["install", "--frozen-lockfile", "--cwd", "src/drive/shared"], root);
run("node", [".upstream/node_modules/typescript/bin/tsc", "-p", "src/drive/shared"], root);
