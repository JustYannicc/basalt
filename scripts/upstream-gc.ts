import { collectUpstreamDependencies } from "./upstream-store.ts";

if (process.argv.length !== 2) throw new Error("Usage: npm run gc:upstream");
if (!(await collectUpstreamDependencies()))
  throw new Error("Dependency cache collection skipped because live usage could not be verified.");
console.log("Collected unused dependency cache entries.");
