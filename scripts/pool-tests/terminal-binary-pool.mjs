import { handlePoolWorkerRequest } from "../../src/pool/worker.ts";
export { Proxy, ModelLifetimeNode } from "./model-lifetime-worker.mjs";

export default {
  fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith("/v1/"))
      return env.PROXY.getByName("proxy").fetch(request);
    return handlePoolWorkerRequest(request, {
      ...env,
      PoolContainer: {
        jurisdiction() {
          return { getByName: () => env.PROXY.getByName("proxy") };
        },
      },
    });
  },
};
