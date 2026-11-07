import { Schema } from "effect";
import { bounded } from "../database-budget-readiness.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { BarrierRefusal } from "./manifest.ts";

export const containerHealth = Schema.Struct({
  instanceId: Schema.String,
  bootId: Schema.String,
  checkedAt: Schema.Number,
});
export type ContainerHealth = typeof containerHealth.Type;
const status = Schema.Struct({
  instanceId: Schema.String,
  imageHash: Schema.String,
  running: Schema.Literal(true),
  ready: Schema.Literal(true),
  bootId: Schema.String,
});

/** Inspect does not reconcile the new Worker's desired image or restart the recovered old image. */
export async function verifyContainerHealth(
  target: PoolOperationsTarget,
  workerImageHash: string,
  signal: AbortSignal,
) {
  const opening = openPoolOperations(target);
  let connection: Awaited<typeof opening> | undefined;
  try {
    connection = await bounded(opening, signal);
    const response = await bounded(
      connection.service.fetch(
        new Request(`http://pool-operations${runtimeRecoveryPath}`, { signal }),
      ),
      signal,
    );
    if (!response.ok) throw new Error();
    const value = Schema.decodeUnknownSync(status)(await bounded(response.json(), signal));
    if (
      value.imageHash !== workerImageHash ||
      !/^[a-f0-9]{64}$/.test(value.instanceId) ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(value.bootId)
    )
      throw new Error();
    return { instanceId: value.instanceId, bootId: value.bootId, checkedAt: Date.now() };
  } catch {
    throw new BarrierRefusal("container-recovery-runtime-unhealthy");
  } finally {
    if (connection) await bounded(connection.close(), signal);
    else void opening.then((value) => value.close()).catch(() => {});
  }
}
