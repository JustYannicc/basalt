import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { openEnvelope } from "../../src/pool/token.ts";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { runtimeHandoffCommandPrefix } from "../../src/pool/runtime-slots/handoff-command.ts";
import { baselineControllerHealth } from "./baseline-controller.ts";
import { controllerForwardHealth } from "./controller-forward-health.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";
import { containerPublication } from "./test/container-fixture.ts";

const controller = () => ({
  code: { candidate: "a".repeat(40), workerInput: "b".repeat(64) },
  target: { accountId: "1".repeat(32), worker: "synthetic-baseline" },
  imageHash: "a".repeat(16),
  versions: [{ versionId: "old-version", percentage: 100 }],
  workerDigest: "2".repeat(64),
  readinessDigest: "3".repeat(64),
});

test("pre-controller reconciliation speaks the frozen baseline protocol before a candidate can upload", async () => {
  const old = { candidate: "a".repeat(40), workerInput: "b".repeat(64) };
  const candidate = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
  const key = "e".repeat(64),
    instanceId = "f".repeat(64);
  const baseline = {
    code: old,
    target: { accountId: "1".repeat(32), worker: "synthetic-baseline" },
    imageHash: "a".repeat(16),
    versions: [{ versionId: "old-version", percentage: 100 }],
    workerDigest: "2".repeat(64),
    readinessDigest: "3".repeat(64),
  };
  const calls: string[] = [];
  let uploads = 0;
  const target = {
    ...baseline.target,
    connect: async () => ({
      dispose: async () => {},
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path === "/runtime-recovery") {
              calls.push("GET runtime-recovery");
              return Response.json({
                instanceId,
                imageHash: baseline.imageHash,
                release: old.candidate,
                running: true,
                ready: true,
                bootId: "old-boot",
              });
            }
            const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
              await request.json(),
            );
            const value = await openEnvelope(key, runtimeHandoffCommandPrefix, body.envelope);
            // The baseline decodes its closed command union before checking controller identity.
            try {
              const command = Schema.decodeUnknownSync(
                Schema.Struct({
                  action: Schema.Literal("inspect"),
                  controllerCode: ControllerCode,
                  at: Schema.Number,
                  expiresAt: Schema.Number,
                }),
                { onExcessProperty: "error" },
              )(value);
              calls.push(`POST ${command.action}`);
              if (JSON.stringify(command.controllerCode) !== JSON.stringify(old))
                return new Response(null, { status: 409 });
              return Response.json({ result: { controllerCode: old } });
            } catch {
              calls.push("POST refused-new-protocol");
              return new Response(null, { status: 409 });
            }
          },
        },
      },
    }),
  };
  const now = Date.now();
  const result = await controllerForwardHealth({
    baseline,
    container: containerPublication().frozen,
    observation: {
      workerVersions: baseline.versions,
      instances: [{ id: instanceId, state: "running", digest: `sha256:${"1".repeat(64)}` }],
      digest: `sha256:${"1".repeat(64)}`,
    },
    baselineHealth: () => baselineControllerHealth({ baseline, key, target }),
    candidateReady: async () => {
      throw new Error("The new controller is not installed");
    },
    candidateHealth: async () => {
      await sendRuntimeCommand(
        { action: "active-health", controllerCode: candidate, at: now, expiresAt: now + 60_000 },
        key,
        target,
        () => {},
      );
      return { instanceId, bootId: "new-boot", checkedAt: now };
    },
  });
  uploads++;
  assert.equal(result.bootId, "old-boot");
  assert.deepEqual(calls, ["POST inspect", "GET runtime-recovery"]);
  assert.equal(uploads, 1);
});

test("new controller health is unavailable until its installed code is proven", async () => {
  const baseline = controller();
  const calls: string[] = [];
  const options = {
    baseline,
    container: containerPublication().frozen,
    observation: {
      workerVersions: [{ versionId: "candidate-version", percentage: 100 }],
      instances: [],
      digest: `sha256:${"1".repeat(64)}`,
    },
    baselineHealth: async () => {
      throw new Error("Old health must not run for candidate code");
    },
    candidateReady: async () => {
      calls.push("candidate-code-ready");
    },
    candidateHealth: async () => {
      calls.push("candidate-health");
      return { instanceId: "f".repeat(64), bootId: "candidate-boot", checkedAt: Date.now() };
    },
  };
  assert.equal((await controllerForwardHealth(options)).bootId, "candidate-boot");
  assert.deepEqual(calls, ["candidate-code-ready", "candidate-health"]);
  calls.length = 0;
  await assert.rejects(
    controllerForwardHealth({
      ...options,
      candidateReady: async () => {
        throw new Error("candidate-code-mismatch");
      },
    }),
    /candidate-code-mismatch/,
  );
  assert.deepEqual(calls, []);
});

for (const fault of ["image", "placement", "boot"] as const)
  test(`baseline ${fault} drift prevents reconciliation`, async () => {
    const baseline = controller();
    const instanceId = "f".repeat(64);
    await assert.rejects(
      controllerForwardHealth({
        baseline,
        container: containerPublication().frozen,
        observation: {
          workerVersions: baseline.versions,
          instances: [
            {
              id: instanceId,
              state: fault === "placement" ? "stopped" : "running",
              digest: `sha256:${"1".repeat(64)}`,
            },
          ],
          digest: `sha256:${(fault === "image" ? "2" : "1").repeat(64)}`,
        },
        baselineHealth: async () => ({
          instanceId: fault === "boot" ? "0".repeat(64) : instanceId,
          bootId: "baseline-boot",
          checkedAt: Date.now(),
        }),
        candidateReady: async () => {
          throw new Error("Candidate code is not installed");
        },
        candidateHealth: async () => {
          throw new Error("Candidate health is not available");
        },
      }),
      /baseline-controller-(placement-unconfirmed|boot-instance-mismatch)/,
    );
  });

test("baseline inspect refuses a slot selection before reading legacy health", async () => {
  let reads = 0;
  const baseline = controller();
  await assert.rejects(
    baselineControllerHealth({
      baseline,
      key: "e".repeat(64),
      target: {
        ...baseline.target,
        connect: async () => ({
          dispose: async () => {},
          env: {
            POOL_OPERATIONS: {
              fetch: async () => {
                reads++;
                return Response.json({
                  result: {
                    controllerCode: baseline.code,
                    selection: { candidate: { fenced: true } },
                  },
                });
              },
            },
          },
        }),
      },
    }),
    /baseline-controller-selection-unexpected/,
  );
  assert.equal(reads, 1);
});
