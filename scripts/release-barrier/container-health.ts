import { Schema } from "effect";
import { bounded } from "../database-budget-readiness.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { BarrierRefusal } from "./manifest.ts";
import { ServingFailure, servingFailure } from "./serving-failure.ts";

export const containerHealth = Schema.Struct({
  instanceId: Schema.String,
  bootId: Schema.String,
  checkedAt: Schema.Number,
});
export type ContainerHealth = typeof containerHealth.Type;
const status = Schema.Struct({
  instanceId: Schema.String,
  imageHash: Schema.String,
  running: Schema.Boolean,
  ready: Schema.Boolean,
  bootId: Schema.optional(Schema.String),
});

/** Inspect does not reconcile the new Worker's desired image or restart the recovered old image. */
export async function verifyContainerHealth(
  target: PoolOperationsTarget,
  workerImageHash: string,
  signal: AbortSignal,
  diagnostic = false,
) {
  const opening = openPoolOperations(target);
  let connection: Awaited<typeof opening> | undefined;
  let failed = false;
  try {
    connection = await bounded(opening, signal);
    const response = await bounded(
      connection.service.fetch(
        new Request(`http://pool-operations${runtimeRecoveryPath}`, { signal }),
      ),
      signal,
    );
    if (!response.ok) {
      await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
      throw new ServingFailure({
        check: "runtime-health",
        cause: "http-status",
        status: response.status,
        expectedStatus: 200,
      });
    }
    const value = Schema.decodeUnknownSync(status)(await bounded(response.json(), signal));
    if (!value.running || !value.ready)
      throw new ServingFailure({
        check: "runtime-health",
        cause: value.running ? "not-ready" : "not-running",
      });
    if (
      value.imageHash !== workerImageHash ||
      !/^[a-f0-9]{64}$/.test(value.instanceId) ||
      !value.bootId ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(value.bootId)
    )
      throw new Error();
    return { instanceId: value.instanceId, bootId: value.bootId, checkedAt: Date.now() };
  } catch (error) {
    failed = true;
    if (diagnostic) throw servingFailure("runtime-health", error);
    throw new BarrierRefusal("container-recovery-runtime-unhealthy");
  } finally {
    if (connection) {
      try {
        await bounded(connection.close(), signal);
      } catch (error) {
        if (!failed)
          throw diagnostic
            ? servingFailure("bridge-close", error)
            : new BarrierRefusal("container-recovery-runtime-unhealthy");
      }
    } else void opening.then((value) => value.close()).catch(() => {});
  }
}
