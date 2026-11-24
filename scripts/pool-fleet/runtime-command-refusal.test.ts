import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BarrierRefusal } from "./refusal.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";
import { runtimeErrorResponse } from "../../src/pool/runtime-slots/request-error.ts";
import { SlotRefused } from "../../src/pool/runtime-slots/contract.ts";
import {
  handleRuntimeHandoff,
  logRuntimeCommandRefusal,
} from "../../src/pool/runtime-slots/http.ts";

const candidate = "c".repeat(40);
const controllerCode = { candidate, workerInput: "d".repeat(64) };
const at = Date.now();
const adopt = {
  action: "adopt",
  proof: "proof",
  controllerCode,
  at,
  expiresAt: at + 60_000,
} as const;

/** The public refusal a fleet operator prints: its reason, worker and redacted delta. */
async function refusedEvidence(_t: TestContext, reply: () => Response) {
  const target = {
    worker: "pool-worker",
    accountId: "account",
    connect: async () => ({
      dispose: async () => {},
      env: { POOL_OPERATIONS: { fetch: async () => reply() } },
    }),
  };
  const error = await sendRuntimeCommand(adopt, "e".repeat(64), target, () => {}).then(
    () => assert.fail("a refused command must throw"),
    (refusal: unknown) => refusal,
  );
  assert.ok(error instanceof BarrierRefusal);
  const text = JSON.stringify({ reason: error.reason, worker: error.worker, delta: error.delta });
  const failure = JSON.parse(text) as {
    reason: string;
    delta: { changed: Array<{ path: string; new?: unknown }> };
  };
  const fields = Object.fromEntries(
    failure.delta.changed.map((change) => [change.path, change.new]),
  );
  return { failure, fields, text };
}

test("a 409 with a known runtime reason reaches failure.json", async (t) => {
  const { failure, fields } = await refusedEvidence(t, () =>
    runtimeErrorResponse(new SlotRefused("draining"), "handoff"),
  );
  assert.equal(failure.reason, "runtime-handoff-response-refused");
  assert.equal(failure.delta.changed[0]!.path, "handoff.response.status");
  assert.deepEqual(
    [
      fields["handoff.command.action"],
      fields["handoff.response.step"],
      fields["handoff.response.reason"],
      fields["handoff.response.code"],
    ],
    ["adopt", "endpoint_route", "slot_draining", "runtime_endpoint_route_slot_draining"],
  );
});

test("an unknown refusal reason is recorded as unclassified and nothing else from the body leaks", async (t) => {
  const marker = "private-refusal-marker";
  const { fields, text } = await refusedEvidence(t, () =>
    Response.json(
      {
        error: "runtime-handoff-refused",
        reason: `free text ${marker}`,
        cause: marker,
        detail: marker,
      },
      {
        status: 409,
        headers: {
          "X-Signalbox-Runtime-Failure-Step": `${marker}-step`,
          "X-Signalbox-Runtime-Failure-Reason": `${marker}-reason`,
        },
      },
    ),
  );
  assert.deepEqual(
    [
      fields["handoff.response.step"],
      fields["handoff.response.reason"],
      fields["handoff.response.code"],
    ],
    ["unclassified", "unclassified", "unclassified"],
  );
  assert.doesNotMatch(text, new RegExp(marker));
});

test("an oversized or non-JSON refusal body is never read into evidence", async (t) => {
  for (const body of ["x".repeat(64 * 1024), "not json"]) {
    const { fields, text } = await refusedEvidence(t, () => new Response(body, { status: 409 }));
    assert.equal(fields["handoff.response.code"], "unclassified");
    assert.doesNotMatch(text, /xxxx|not json/);
  }
});

test("the pool logs each refused runtime command once with its closed reason", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => {
    lines.push(line);
  });
  logRuntimeCommandRefusal(runtimeErrorResponse(new SlotRefused("identity"), "handoff"), {
    action: "adopt",
    candidate,
    operationId: null,
  });
  assert.deepEqual(lines, [
    `POOL_RUNTIME_COMMAND_REFUSED {"action":"adopt","candidate":"${candidate}","operationId":null,"status":409,"step":"endpoint_route","reason":"slot_identity"}`,
  ]);
});

test("every answer but a 200 logs one line with its status, early refusals and defects too", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => {
    lines.push(line);
  });
  const handoff = { databasePool: () => null } as unknown as Parameters<
    typeof handleRuntimeHandoff
  >[1];
  const answers = [
    await handleRuntimeHandoff(
      new Request("http://pool/handoff", { method: "GET" }),
      handoff,
      controllerCode,
      "e".repeat(64),
    ),
    await handleRuntimeHandoff(
      new Request("http://pool/handoff", { method: "POST", body: "x".repeat(256 * 1024 + 1) }),
      handoff,
      controllerCode,
      "e".repeat(64),
    ),
  ];
  // A signed fleet-inspect on a controller with no fleet is a defect, answered 500.
  let defect: Response | undefined;
  await sendRuntimeCommand(
    { action: "fleet-inspect", controllerCode, at, expiresAt: at + 60_000 },
    "e".repeat(64),
    {
      worker: "pool-worker",
      accountId: "account",
      connect: async () => ({
        dispose: async () => {},
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) =>
              (defect = await handleRuntimeHandoff(
                request,
                handoff,
                controllerCode,
                "e".repeat(64),
              )),
          },
        },
      }),
    },
    () => {},
  ).catch(() => undefined);
  assert.deepEqual(
    [...answers, defect!].map((answer) => answer.status),
    [405, 413, 500],
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line.replace("POOL_RUNTIME_COMMAND_REFUSED ", ""))),
    [
      { action: null, candidate: null, operationId: null, status: 405, step: null, reason: null },
      { action: null, candidate: null, operationId: null, status: 413, step: null, reason: null },
      {
        action: "fleet-inspect",
        candidate,
        operationId: null,
        status: 500,
        step: "endpoint_route",
        reason: "transport",
      },
    ],
  );
});

test("a stalled refusal body is abandoned as unclassified rather than holding the release", async (t) => {
  const { fields } = await refusedEvidence(
    t,
    () =>
      new Response(
        new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([123])) }),
        {
          status: 409,
        },
      ),
  );
  assert.equal(fields["handoff.response.code"], "unclassified");
});
