import assert from "node:assert/strict";
import { openEnvelope } from "../../../src/pool/token.ts";
import { runtimeHandoffCommandPrefix } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { deploymentReadinessPrefix } from "../../../src/pool/deployment-readiness.ts";

export function firstHandoffBridge({
  accountId,
  scriptName,
  key,
  f,
  options,
  events,
  current,
  replace,
}) {
  const target = {
    accountId,
    worker: scriptName,
    connect: async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/runtime-recovery") return current().fetch(request);
            const { envelope } = await request.clone().json();
            if (path === "/deployment-readiness") {
              const command = await openEnvelope(key, deploymentReadinessPrefix, envelope);
              return Response.json(
                command.phase === "adoption"
                  ? current().deploymentIdentity()
                  : await current().deploymentReady(),
              );
            }
            assert.equal(path, "/runtime-handoff");
            const command = await openEnvelope(key, runtimeHandoffCommandPrefix, envelope);
            if (command.action === "adopt" && options.earlyAdvance)
              replace(f.advanceCurrentBindings(f.candidate.env));
            if (command.action === "stage" && options.proveRetainedModel) {
              const model = await f.model();
              assert.equal(model.status, 200);
              assert.equal(model.headers.get("X-Signalbox-Pool-Boot"), f.old.identity().bootId);
              await model.body?.cancel();
              events.push({
                action: "legacy-model-under-new-current",
                desired: current().deploymentIdentity().imageHash,
              });
            }
            const response = await current().runtimeHandoff(request);
            events.push({
              action: command.action,
              http: response.status,
              desired: current().deploymentIdentity().imageHash,
            });
            if (command.action === "stage" && options.lostStartAck)
              throw new Error("lost candidate start reply");
            if (command.action === "promote" && options.lostPromotionAck)
              throw new Error("lost promotion reply");
            if (command.action === "drain" && options.lostDrainAck)
              throw new Error("lost drain reply");
            if (command.action === "adopt") {
              if (options.lostAck) throw new Error("lost adoption ACK after runtime commit");
              if (options.missingAck) return Response.json({ result: null });
              if (options.refusedAck) return new Response(null, { status: 409 });
            }
            const fault =
              command.action === "adopt"
                ? options.ackFault
                : command.action === "witness"
                  ? options.readbackFault
                  : undefined;
            if (fault && response.status === 200) {
              const value = await response.json();
              if (fault === "operation") value.result.operationId = "foreign-operation";
              if (fault === "boot") value.result.identity.bootId = "foreign-boot";
              if (fault === "selection") value.result.selection.expectedEpoch++;
              return Response.json(value);
            }
            return response;
          },
        },
      },
      dispose: async () => {},
    }),
  };
  return target;
}
