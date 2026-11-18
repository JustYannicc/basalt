import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetWorkerFixture } from "./pool-tests/runtime-fleet-worker.ts";
import { runtimeFixtureCode } from "./pool-tests/runtime-handoff-proofs.ts";
import { deploymentReadinessPrefix } from "../src/pool/deployment-readiness.ts";
import { openEnvelope } from "../src/pool/token.ts";
import { crashOperatorOptions, runCrashOperator } from "./pool-crash-operator.ts";

test(
  "a lost crash reply retains a private marker and the next invocation only inspects",
  { timeout: 20_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    const directory = await mkdtemp(join(tmpdir(), "runtime-crash-operator-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "operator-fixture",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const initial = await f.model();
    await initial.body?.cancel();
    await f.settle();
    await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
    const packet = {
      accountId: "a".repeat(32),
      worker: "synthetic-pool",
      controllerCode: runtimeFixtureCode,
      identity: f.old.identity(),
      nonce: crypto.randomUUID(),
      operator: "fixture-operator",
    };
    const path = join(directory, "packet.json");
    await writeFile(path, JSON.stringify(packet), { mode: 0o600 });
    const actions: string[] = [];
    const secret = f.old.env.POOL_DEPLOYMENT_KEY!;
    const connect = async (configPath: string) => {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(config.services, [
        {
          binding: "POOL_OPERATIONS",
          service: packet.worker,
          entrypoint: "PoolOperations",
          remote: true,
        },
      ]);
      return {
        dispose: async () => {},
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) => {
              const { envelope } = (await request.clone().json()) as { envelope: string };
              const command = (await openEnvelope(secret, deploymentReadinessPrefix, envelope)) as {
                action: string;
              };
              actions.push(command.action);
              const response = await f.worker.runtimeHandoff(request);
              assert.equal(response.status, 200, await response.clone().text());
              if (command.action === "runtime-crash") throw new Error("synthetic lost reply");
              return response;
            },
          },
        },
      };
    };
    const options = { packet: path, apply: true };
    await assert.rejects(runCrashOperator(options, secret, { connect }), /synthetic lost reply/);
    assert.deepEqual(f.old.calls.signals, [9]);
    const result = await runCrashOperator(options, secret, { connect });
    assert.equal(result.status, "inspection");
    assert.deepEqual(actions, ["runtime-crash", "runtime-crash-inspect"]);
    assert.deepEqual(f.old.calls.signals, [9]);
    assert.equal((await stat(`${path}.submitted.json`)).mode & 0o777, 0o600);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.match(await readFile(result.receiptPath, "utf8"), /signalled/);
    await writeFile(path, JSON.stringify({ ...packet, nonce: crypto.randomUUID() }));
    await assert.rejects(
      runCrashOperator(options, secret, { connect }),
      /Submitted crash packet changed/,
    );
    assert.equal(actions.length, 2);
  },
);

test("crash CLI requires an explicit operation and never connects without an operator key", async () => {
  assert.throws(() => crashOperatorOptions(["--packet", "private"]));
  assert.deepEqual(crashOperatorOptions(["--packet", "private", "--inspect"]), {
    packet: "private",
    apply: false,
  });
  await assert.rejects(
    runCrashOperator({ packet: "unused", apply: true }, ""),
    /Operator signing key required/,
  );
});
