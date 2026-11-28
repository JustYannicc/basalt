import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runPoolFleet, stepSummary, type DispatchInput } from "./dispatch.ts";
import { platformMessages } from "./runtime-command-rpc.ts";
import { harness } from "./test/harness.ts";
import { otherCodeRefusal } from "./test/other-code.ts";
import { throughController } from "../../src/pool/operations-call.ts";
import { runtimeHandoffPath } from "../../src/pool/runtime-slots/handoff-command.ts";

const go = "coordinator-2026-11-28-read-retry";
const dispatch = (mode: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({
  mode,
  go,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  ...extra,
});
type Result = Awaited<ReturnType<typeof runPoolFleet>>;
const cause = (result: Result) => String("cause" in result ? result.cause : "");
const sessionsOf = (result: Result) => ("readSessions" in result ? result.readSessions : undefined);
const sent = (actions: string[], action: string) => actions.filter((one) => one === action).length;
/** The session proxy's own answer when its call into the pool throws: the message as a 500. */
const proxyAnswer = (message: string = platformMessages[0].text) =>
  new Response(message, { status: 500 });

async function run(input: DispatchInput, lane: Awaited<ReturnType<typeof harness>>) {
  const lines: string[] = [];
  const result = await runPoolFleet(input, { ...lane.deps(), log: (line) => lines.push(line) });
  return { result, lines };
}

test("a read the pool never answered goes again on a fresh session, and the run says it took 2", async () => {
  let answers = 0;
  const lane = await harness({
    handoffFailure: (action) =>
      action === "inspect" && answers++ === 0 ? proxyAnswer() : undefined,
  });
  try {
    const { result, lines } = await run(dispatch("inspect", { go: "" }), lane);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(sessionsOf(result), [{ action: "inspect", sessions: 2, ok: true }]);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("read_sessions")),
      ["read_sessions action=inspect sessions=2 ok=true"],
    );
    assert.match(
      stepSummary(result),
      /^- Reads sent again because the pool never answered: inspect on 2 sessions$/mu,
    );
    // The probe took two sessions; the inspect's own reads one each.
    assert.deepEqual(lane.actions, ["inspect", "inspect", "inspect", "fleet-inspect"]);
    assert.equal(lane.opened.sessions, 4);
  } finally {
    await lane.close();
  }
});

test("three sessions the pool never answered fail the read, and its refusal says 3", async () => {
  const lane = await harness({
    handoffFailure: (action) => (action === "inspect" ? proxyAnswer() : undefined),
  });
  try {
    const { result, lines } = await run(dispatch("inspect", { go: "" }), lane);
    assert.equal(result.ok, false);
    assert.match(
      cause(result),
      /handoff\.command\.action=inspect handoff\.response\.http=500 handoff\.response\.origin=unmarked .* handoff\.command\.sessions=3\)$/u,
    );
    assert.deepEqual(sessionsOf(result), [{ action: "inspect", sessions: 3, ok: false }]);
    assert.ok(lines.includes("read_sessions action=inspect sessions=3 ok=false"));
    assert.match(stepSummary(result), /inspect on 3 sessions, failed$/mu);
    assert.deepEqual(lane.actions, ["inspect", "inspect", "inspect"]);
    assert.equal(lane.opened.sessions, 3);
  } finally {
    await lane.close();
  }
});

test("the pool's own refusal is its real answer and is sent once", async () => {
  const oldCode = await otherCodeRefusal();
  // The pool's entrypoint answers 500 itself when its call into the controller throws.
  const callFailed = await throughController(
    runtimeHandoffPath,
    () => Promise.reject(new Error("lost")),
    () => {},
  );
  for (const [answer, refusal] of [
    [oldCode, /^controller-code-mismatch: /u],
    [callFailed, /handoff\.response\.http=500 handoff\.response\.origin=pool .*\)$/u],
  ] as const) {
    const lane = await harness({
      handoffFailure: (action) => (action === "inspect" ? answer.clone() : undefined),
    });
    try {
      const { result, lines } = await run(dispatch("inspect", { go: "" }), lane);
      assert.equal(result.ok, false, String(answer.status));
      assert.match(cause(result), refusal);
      assert.doesNotMatch(cause(result), /sessions=|answeredBy=/u);
      assert.equal(sessionsOf(result), undefined);
      assert.deepEqual(
        lines.filter((line) => line.startsWith("read_sessions")),
        [],
      );
      assert.deepEqual(lane.actions, ["inspect"]);
    } finally {
      await lane.close();
    }
  }
});

test("the lane's own time limit and a bridge that failed before any answer are not sent again", async () => {
  for (const [failure, named] of [
    [() => new DOMException("limit", "TimeoutError"), "DOMException"],
    [() => new DOMException("limit", "AbortError"), "DOMException"],
    [() => new Error("bridge reset"), "Error"],
  ] as const) {
    const lane = await harness({
      handoffFailure: (action) => (action === "inspect" ? failure() : undefined),
    });
    try {
      const { result } = await run(dispatch("inspect", { go: "" }), lane);
      assert.equal(result.ok, false);
      assert.equal(cause(result), named);
      assert.equal(sessionsOf(result), undefined);
      assert.deepEqual(lane.actions, ["inspect"]);
    } finally {
      await lane.close();
    }
  }
});

const configured = async (lane: Awaited<ReturnType<typeof harness>>) =>
  assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
const writes = [
  { mode: "configure-and-accept", action: "fleet-configure", before: async () => {} },
  { mode: "disable", action: "fleet-disable", before: configured },
  { mode: "crash-cell", action: "runtime-crash", before: configured },
  { mode: "bookmark", action: "storage-bookmark", before: async () => {} },
  {
    mode: "retire-row",
    action: "fleet-retire",
    before: async (lane: Awaited<ReturnType<typeof harness>>) => {
      await configured(lane);
      const rows = lane.storage.values.get("runtime-fleet-v1:resources") as object[];
      lane.storage.values.set(
        "runtime-fleet-v1:resources",
        rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
      );
    },
  },
] as const;
const rowKey = createHash("sha256").update("runtime-cell-1").digest("hex").slice(0, 8);

test("every write stops on its first answer the pool never gave: configure, disable, crash-cell, bookmark and retire-row", async () => {
  for (const write of writes) {
    let armed = false;
    const lane = await harness({
      handoffFailure: (action) => (armed && action === write.action ? proxyAnswer() : undefined),
    });
    try {
      await write.before(lane);
      armed = true;
      const { result } = await run(
        dispatch(write.mode, { go: `${go}-${write.action}`, key: rowKey }),
        lane,
      );
      assert.equal(result.ok, false, write.mode);
      assert.equal(sent(lane.actions, write.action), 1, write.mode);
      assert.match(
        cause(result),
        new RegExp(
          `handoff\\.command\\.action=${write.action} handoff\\.response\\.http=500 handoff\\.response\\.origin=unmarked `,
          "u",
        ),
        write.mode,
      );
      assert.doesNotMatch(cause(result), /sessions=/u, write.mode);
      assert.equal(sessionsOf(result), undefined, write.mode);
    } finally {
      await lane.close();
    }
  }
});

/**
 * Fails the nth send after the configure with the proxy's own 500, once. In order, the sends
 * after it are the configure's read-back, the ready wait's primary and fleet reads, then the
 * acceptance's.
 */
const unansweredAfterConfigure = (send: number) => {
  let after: number | undefined;
  return (action: string) => {
    if (action === "fleet-configure") after = 0;
    else if (after !== undefined && ++after === send) return proxyAnswer();
    return undefined;
  };
};

async function configureWithOneUnanswered(send: number, action: string) {
  const lane = await harness({ handoffFailure: unansweredAfterConfigure(send) });
  try {
    const { result, lines } = await run(dispatch("configure-and-accept"), lane);
    const enabled = (await lane.configuration.inspect())?.enabled;
    assert.equal(
      enabled,
      true,
      `the fleet was disabled: ${JSON.stringify("rollback" in result ? result.rollback : null)}`,
    );
    assert.equal(sent(lane.actions, "fleet-disable"), 0);
    assert.equal(result.ok, true, JSON.stringify(result));
    const configure = lane.actions.indexOf("fleet-configure");
    assert.deepEqual(lane.actions.slice(configure + send, configure + send + 2), [action, action]);
    assert.deepEqual(sessionsOf(result), [{ action, sessions: 2, ok: true }]);
    assert.ok(lines.includes(`read_sessions action=${action} sessions=2 ok=true`));
  } finally {
    await lane.close();
  }
}

test("configure-and-accept keeps the fleet it configured when one ready-wait read is answered by the session's proxy", async () => {
  await configureWithOneUnanswered(2, "inspect");
  await configureWithOneUnanswered(3, "fleet-inspect");
});

test("configure-and-accept keeps the fleet it configured when one acceptance read is answered by the session's proxy", async () => {
  await configureWithOneUnanswered(4, "inspect");
  await configureWithOneUnanswered(5, "fleet-inspect");
});

test("an unmarked answer keeps who made it, its length, its message and its ray header as closed values only", async () => {
  const marker = "privatemarker0123";
  const ray = { "CF-Ray": `${marker}-AMS` };
  const page = `<!DOCTYPE html><html><head><title>${marker}</title></head></html>`;
  const json = JSON.stringify({ error: marker });
  const cases = [
    ...platformMessages.map(({ word, text }) => ({
      answer: () => proxyAnswer(text),
      by: "proxy",
      bytes: Buffer.byteLength(text),
      message: word,
      ray: "no",
    })),
    {
      answer: () => proxyAnswer(`internal error; reference = ${marker}`),
      by: "proxy",
      bytes: Buffer.byteLength(`internal error; reference = ${marker}`),
      message: "internal_error",
      ray: "no",
    },
    {
      answer: () => proxyAnswer(`free text ${marker}`),
      by: "proxy",
      bytes: Buffer.byteLength(`free text ${marker}`),
      message: "other",
      ray: "no",
    },
    {
      answer: () =>
        new Response(page, {
          status: 502,
          headers: { "Content-Type": "text/html; charset=UTF-8", ...ray },
        }),
      by: "edge",
      bytes: Buffer.byteLength(page),
      message: "other",
      ray: "yes",
    },
    {
      answer: () => new Response(null, { status: 500, headers: ray }),
      by: "nothing",
      bytes: 0,
      message: "other",
      ray: "yes",
    },
    {
      answer: () =>
        new Response(json, { status: 503, headers: { "Content-Type": "application/json" } }),
      by: "other",
      bytes: Buffer.byteLength(json),
      message: "other",
      ray: "no",
    },
  ];
  for (const expected of cases) {
    const lane = await harness({
      handoffFailure: (action) => (action === "inspect" ? expected.answer() : undefined),
    });
    try {
      const { result, lines } = await run(dispatch("inspect", { go: "" }), lane);
      assert.equal(result.ok, false);
      assert.match(
        cause(result),
        new RegExp(
          `handoff\\.response\\.answeredBy=${expected.by} handoff\\.response\\.bytes=${expected.bytes} handoff\\.response\\.message=${expected.message} handoff\\.response\\.ray=${expected.ray} handoff\\.command\\.sessions=3\\)$`,
          "u",
        ),
        expected.by,
      );
      const everything = [JSON.stringify(result), stepSummary(result), ...lines].join("\n");
      assert.doesNotMatch(everything, new RegExp(marker, "u"), expected.by);
      for (const { text } of platformMessages) assert.ok(!everything.includes(text), expected.by);
    } finally {
      await lane.close();
    }
  }
});
