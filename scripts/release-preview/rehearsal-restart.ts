import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { ControllerRefused, observeSender } from "../pool-crash-dispatch.ts";
import { readReleaseTarget } from "../pool-crash-dispatch-sources.ts";
import { runCrashOperator } from "../pool-crash-operator.ts";
import { isRehearsalStage } from "../release-barrier/release-stage.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import {
  RestartRefusal,
  runRestartCheck,
  type Observation,
  type Request,
  type SlotIdentity,
} from "./rehearsal-restart-plan.ts";

const requestGapMs = 250;

/** Runs only against a rehearsal stage, with that stage's own deployment key. */
async function main(env: NodeJS.ProcessEnv) {
  if (!isRehearsalStage(env.ALCHEMY_STAGE))
    throw new Error("The restart check runs only on a rehearsal stage");
  const key = env.POOL_DEPLOYMENT_KEY ?? "";
  const candidate = env.BASALT_RELEASE_CANDIDATE ?? "";
  const output = env.REHEARSAL_RESTART_RESULT ?? "";
  const modelUrl = env.REHEARSAL_MODEL_URL ?? "";
  const modelKey = env.REHEARSAL_MODEL_KEY ?? "";
  const model = env.REHEARSAL_MODEL ?? "";
  if (!/^[a-f0-9]{40}$/u.test(candidate) || !key || !output || !modelUrl || !modelKey || !model)
    throw new Error("The restart check is missing its inputs");
  const target = await readReleaseTarget(env);
  const controllerCode = { candidate, workerInput: poolWorkerRevision };
  const send = observeSender();
  const result = async (action: "inspect" | "fleet-inspect" | "active-health") => {
    const reply = (await send(action, controllerCode, target, key)) as { result?: unknown };
    return reply.result;
  };
  const observe = async (): Promise<Observation> => {
    const inspected = (await result("inspect")) as { selection?: Observation["selection"] };
    const fleet = (await result("fleet-inspect")) as Observation["fleet"];
    const activeHealth = (await result("active-health").catch((cause: unknown) => {
      if (cause instanceof ControllerRefused) return null;
      throw cause;
    })) as Observation["activeHealth"];
    return { selection: inspected?.selection ?? null, fleet, activeHealth };
  };
  // The production proof's load: workers each sending short streamed turns back to back.
  const client = new PoolAcceptanceClient({ origin: modelUrl });
  const requests: Request[] = [];
  let workers = 0;
  let stopped = false;
  const loops: Promise<void>[] = [];
  const worker = async () => {
    while (!stopped) {
      const startedAt = Date.now();
      const ok = await client
        .sendTurn(modelKey, model, { id: randomUUID(), expectedRecords: 1 })
        .then(
          () => true,
          () => false,
        );
      requests.push({ ok, startedAt, endedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, requestGapMs));
    }
  };
  const scratch = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "rehearsal-restart-"));
  let outcome: object;
  try {
    outcome = await runRestartCheck({
      observe,
      setConcurrency: (count) => {
        for (; workers < count; workers += 1) loops.push(worker());
      },
      requests: () => requests,
      crash: async (identity: SlotIdentity) => {
        const packet = join(scratch, "packet.json");
        await writeFile(
          packet,
          JSON.stringify({
            accountId: target.accountId,
            worker: target.worker,
            controllerCode,
            identity,
            nonce: `rehearsal-restart-${randomUUID().slice(0, 8)}`,
            operator: "release-rehearsal",
          }),
          { mode: 0o600, flag: "wx" },
        );
        await runCrashOperator({ packet, apply: true }, key);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
  } catch (error) {
    outcome = { refused: error instanceof RestartRefusal ? error.reason : "restart-check-failed" };
  } finally {
    stopped = true;
    await Promise.all(loops);
    await rm(scratch, { recursive: true, force: true });
  }
  await writeFile(output, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  if ("refused" in outcome) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main(process.env);
  } catch {
    console.error("Rehearsal restart check could not run");
    process.exitCode = 1;
  }
}
