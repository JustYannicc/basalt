import { registerHooks } from "node:module";

const production = new URL("../../pool-operations-node-worker.mjs", import.meta.url).href;
const binding = new URL("./local-operations-binding.mjs", import.meta.url).href;
// Replace only Wrangler's binding destination; the production IPC dispatcher stays intact.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === production && specifier === "./pool-operations.ts")
      return { url: binding, shortCircuit: true };
    return next(specifier, context);
  },
});
await import(production);
