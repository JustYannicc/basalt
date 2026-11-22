import { registerHooks } from "node:module";

// Replaces the delivery worker with one that delivers revision 1 once and then nothing, so the
// lone-commit test passes its first delivery and stalls in the second as a missed wake-up would.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith("/apps/hosted/self-host/src/implementation/committed-change-delivery.ts")
      ? {
          format: "module",
          shortCircuit: true,
          source: [
            'console.log("committed change delivery replaced by a worker that delivers only revision 1");',
            "export const committedChangeDelivery = (send) =>",
            '  send("organization:team-a", { revision: "1" });',
          ].join("\n"),
        }
      : nextLoad(url, context),
});
