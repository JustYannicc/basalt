import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Miniflare 4 nests a workerd with a container socket leak. Select the fixed binary before loading it.
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
export const { Miniflare } = require("miniflare") as typeof import("miniflare");
