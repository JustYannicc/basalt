import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  decodeRuntimeHandoffCommand,
  runtimeHandoffCommandPrefix,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";
import {
  freezeRuntimeFleetOperation,
  runtimeFleetOperationDigest,
} from "./runtime-fleet-operation.ts";
import { runFleetOperator, fleetOperatorOptions } from "./fleet-operator.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-operator-proof-"));
  const path = join(root, "private.json"),
    signingKey = "a".repeat(64);
  let now = 100,
    lost = false;
  const operation = freezeRuntimeFleetOperation({
    candidate: "b".repeat(40),
    controller: { accountId: "1".repeat(32), scriptName: "synthetic-only" },
    bridgeKeyDigest: runtimeBridgeKeyDigest(signingKey),
    command: {
      action: "fleet-disable",
      operationId: "disable-1",
      expectedDigest: "c".repeat(64),
      controllerCode: { candidate: "b".repeat(40), workerInput: "d".repeat(64) },
    },
  });
  const packet = {
    operation,
    enable: {
      coordinatorGo: "fixture-only",
      manifest: runtimeFleetOperationDigest(operation),
      writerLease: "exclusive-fixture",
      expiresAt: 60_100,
    },
  };
  await writeFile(path, JSON.stringify(packet), { mode: 0o600 });
  const calls: string[] = [];
  const connect: PoolOperationsTarget["connect"] = async () => ({
    env: {
      POOL_OPERATIONS: {
        fetch: async (request) => {
          const body = (await request.json()) as { envelope: string };
          const command = decodeRuntimeHandoffCommand(
            await openEnvelope(signingKey, runtimeHandoffCommandPrefix, body.envelope),
            now,
          );
          calls.push(command.action);
          if (lost) {
            lost = false;
            throw new Error("synthetic lost response");
          }
          return Response.json({
            result: {
              operationId: command.action === "fleet-inspect" ? command.operationId : "disable-1",
            },
          });
        },
      },
    },
    dispose: async () => {},
  });
  return {
    path,
    packet,
    calls,
    run: (apply = true) =>
      runFleetOperator({ packet: path, apply }, signingKey, { connect, now: () => now }),
    lose: () => {
      lost = true;
    },
    expire: () => {
      now = 1_000_000;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a submitted operation can only be inspected on repeat, including after the GO expires", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  assert.equal((await f.run()).status, "acknowledged");
  f.expire();
  assert.equal((await f.run()).status, "inspection");
  assert.deepEqual(f.calls, ["fleet-disable", "fleet-inspect"]);
  const receipt = JSON.parse(await readFile(`${f.path}.receipt.json`, "utf8"));
  assert.equal(receipt.result.result.operationId, "disable-1");
});

test("a lost mutation response retains its submission and cannot send another write", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.lose();
  await assert.rejects(f.run(), /lost response/);
  const marker = JSON.parse(await readFile(`${f.path}.submitted.json`, "utf8"));
  assert.equal(marker.disposition, "submitted");
  f.expire();
  assert.equal((await f.run()).status, "inspection");
  assert.deepEqual(f.calls, ["fleet-disable", "fleet-inspect"]);
});

test("explicit inspection never submits, and a changed packet cannot reuse another manifest's marker", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  assert.equal((await f.run(false)).status, "inspection");
  await assert.rejects(readFile(`${f.path}.submitted.json`), { code: "ENOENT" });
  await f.run();
  await writeFile(
    f.path,
    JSON.stringify({
      ...f.packet,
      operation: {
        ...f.packet.operation,
        command: { ...f.packet.operation.command, expectedDigest: "f".repeat(64) },
      },
    }),
  );
  await assert.rejects(f.run(), /input-drift/);
  assert.deepEqual(f.calls, ["fleet-inspect", "fleet-disable"]);
});

test("invalid GO creates no submission marker and command options stay closed", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await writeFile(
    f.path,
    JSON.stringify({ ...f.packet, enable: { ...f.packet.enable, coordinatorGo: "" } }),
  );
  await assert.rejects(f.run());
  await assert.rejects(readFile(`${f.path}.submitted.json`), { code: "ENOENT" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fleetOperatorOptions(["--packet", "private.json", "--inspect"]), {
    packet: "private.json",
    apply: false,
  });
  assert.throws(() => fleetOperatorOptions(["--packet", "private.json", "--force"]));
});
