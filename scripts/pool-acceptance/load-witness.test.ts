import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceCredential } from "../release/acceptance-device.ts";
import { loadOutcomes } from "./load-classes.ts";
import { runLoad, summaryLines } from "./load.ts";
import { mockWitness, type MockSend } from "./load-witness.ts";
import { chatOnly, deviceEnv, load, stage, streamed, testClock } from "./test/load-fixtures.ts";
import { witnessKey } from "./test/fake-mock.ts";

const late = 31_000;
/** Every outcome but those named is zero. */
function onlyCounts(counts: Record<string, number>, expected: Record<string, number>) {
  for (const name of loadOutcomes) assert.equal(counts[name], expected[name] ?? 0, name);
}

test("a call both witnesses saw in time passes, and the mock's record is read", async () => {
  const { run, lines, mock } = await load([streamed()], 1);
  assert.deepEqual(run.calls[0]!.classes, []);
  assert.equal(run.verdict.passed, true);
  assert.deepEqual(run.verdict.witness, { read: true, sends: 1 });
  assert.ok(lines.includes("load witness=read sends=1"));
  const [send] = mock.rows.values();
  assert.equal(send!.status, 200);
  assert.equal(send!.end, "complete");
  assert.ok(send!.firstContentAt !== undefined);
});

test("a call both witnesses saw late is delayed", async () => {
  const clock = testClock();
  // Time passes before the mock passes the content on: both the mock and the driver see it.
  const { run } = await load([streamed({ beforeFirstByte: () => clock.advance(late) })], 1, clock);
  assert.deepEqual(run.calls[0]!.classes, ["delayed"]);
  onlyCounts(run.verdict.counts, { delayed: 1 });
  assert.equal(run.verdict.passed, false);
});

test("a call the driver saw late and the mock sent in time is a disagreement, not delayed", async () => {
  const clock = testClock();
  // The mock passed the answer on in time; it reached the driver late.
  const { run } = await load([streamed({ afterSent: () => clock.advance(late) })], 1, clock);
  assert.deepEqual(run.calls[0]!.classes, ["witnesses_disagree"]);
  onlyCounts(run.verdict.counts, { witnesses_disagree: 1 });
  assert.equal(run.verdict.passed, false);
});

test("a call the driver saw in time and the mock sent late is a disagreement, and fails the run", async () => {
  const shifted = (send: MockSend): MockSend => ({
    ...send,
    firstContentAt: send.firstContentAt! + late,
    endedAt: send.endedAt + late,
  });
  const stalled = (send: MockSend): MockSend => ({ ...send, stallMs: late });
  // Held before it reached the mock: the mock's wait counts from the driver's send, not its receipt.
  const queued = (send: MockSend): MockSend => ({
    ...shifted(send),
    receivedAt: send.receivedAt + late,
    headersAt: send.headersAt + late,
  });
  for (const says of [shifted, stalled, queued]) {
    const { run } = await load([streamed({ says: (send) => [says(send)] })], 1);
    assert.equal(run.calls[0]!.attempts[0]!.verdict?.pass, true, "the driver saw a clean answer");
    assert.deepEqual(run.calls[0]!.classes, ["witnesses_disagree"], says.name);
    onlyCounts(run.verdict.counts, { witnesses_disagree: 1 });
    assert.equal(run.verdict.passed, false);
  }
});

test("a 200 record cut before any content vouches for nothing, though its wait still counts", async () => {
  const empty = (send: MockSend, by = 0): MockSend => ({
    ...send,
    end: "cut",
    firstContentAt: undefined,
    stallMs: undefined,
    endedAt: send.headersAt + by,
  });
  // The only record the mock has carried no content: the driver's content came from no send it saw.
  const alone = await load([streamed({ says: (send) => [empty(send)] })], 1);
  assert.deepEqual(alone.run.calls[0]!.classes, ["mock_missing"]);
  assert.equal(alone.run.verdict.passed, false);
  // A refusal's content is no answer's content: a 429 beside it still leaves the 200 unvouched.
  const refused = await load(
    [
      streamed({
        says: (send) => [empty(send), { ...send, status: 429 }],
      }),
    ],
    1,
  );
  assert.deepEqual(refused.run.calls[0]!.classes, ["mock_missing"]);
  // A try cut late, beside the send that carried the content in time: the mock says late.
  const beside = await load([streamed({ says: (send) => [empty(send, late), send] })], 1);
  assert.deepEqual(beside.run.calls[0]!.classes, ["witnesses_disagree"]);
});

test("an answer the driver read to its end that the mock's record never ended is mock_cut, and fails the run", async () => {
  // The mock passed the first content on, then its record ends cut: it never vouched for the end.
  const cutAfter = (send: MockSend): MockSend => ({
    ...send,
    end: "cut",
    stallMs: undefined,
    endedAt: send.firstContentAt!,
  });
  const { run, lines } = await load([streamed({ says: (send) => [cutAfter(send)] })], 1);
  assert.equal(run.calls[0]!.attempts[0]!.end, "complete", "the driver read it to its end");
  assert.deepEqual(run.calls[0]!.classes, ["mock_cut"]);
  onlyCounts(run.verdict.counts, { mock_cut: 1 });
  assert.equal(run.verdict.passed, false);
  assert.match(lines[1]!, / mock_cut=1 /u);
  // Beside a record that did end the answer, the cut try vouches for nothing and costs nothing.
  const beside = await load([streamed({ says: (send) => [cutAfter(send), send] })], 1);
  assert.deepEqual(beside.run.calls[0]!.classes, []);
  // Nor does a complete record that carried no content.
  const empty = await load(
    [
      streamed({
        says: (send) => [
          cutAfter(send),
          { ...send, firstContentAt: undefined, stallMs: undefined },
        ],
      }),
    ],
    1,
  );
  assert.deepEqual(empty.run.calls[0]!.classes, ["mock_cut"]);
  // A complete record of a refusal does not end the answer either.
  const refused = await load(
    [streamed({ says: (send) => [cutAfter(send), { ...send, status: 429 }] })],
    1,
  );
  assert.deepEqual(refused.run.calls[0]!.classes, ["mock_cut"]);
});

test("only the mock's 200 answers judge a call, and every one of them does", async () => {
  const later = (send: MockSend): MockSend => ({
    ...send,
    firstContentAt: send.firstContentAt! + late,
    endedAt: send.endedAt + late,
  });
  // A late refusal beside the answer in time: the refusal gets no say.
  const refused = await load(
    [streamed({ says: (send) => [{ ...later(send), status: 429 }, send] })],
    1,
  );
  assert.deepEqual(refused.run.calls[0]!.classes, []);
  assert.equal(refused.run.verdict.passed, true);
  // A second answer, late: the first one in time does not speak for it.
  const second = await load([streamed({ says: (send) => [send, later(send)] })], 1);
  assert.deepEqual(second.run.calls[0]!.classes, ["witnesses_disagree"]);
});

test("a 200 the mock has no record of is mock_missing, and fails the run", async () => {
  const { run, lines } = await load([streamed({ says: () => [] })], 1);
  assert.deepEqual(run.calls[0]!.classes, ["mock_missing"]);
  onlyCounts(run.verdict.counts, { mock_missing: 1 });
  assert.deepEqual(run.verdict.witness, { read: true, sends: 0 });
  assert.equal(run.verdict.passed, false);
  assert.match(lines[1]!, / mock_missing=1 /u);
});

test("a send the mock recorded and the driver never made is driver_missing, and fails the run", async () => {
  const { run, lines } = await load(
    [
      streamed({
        says: (send) => [send, { ...send, marker: send.marker.replace(/-1$/u, "-2") }],
      }),
    ],
    1,
  );
  assert.deepEqual(run.calls[0]!.classes, [], "the call itself is in time by both witnesses");
  onlyCounts(run.verdict.counts, { driver_missing: 1 });
  assert.equal(run.verdict.passed, false);
  assert.match(lines[1]!, / driver_missing=1$/u);
});

test("a record that cannot be read, or not all of it, fails every call as mock_missing", async () => {
  const unreadable: Record<string, (fetched: typeof fetch) => typeof fetch> = {
    "a refused page": () => async () => new Response("{}", { status: 503 }),
    "a record of the wrong shape": () => async () =>
      Response.json({ sends: [{ marker: "lw", status: "200" }] }),
    "a cursor that is not text": () => async () => Response.json({ sends: [], next: 7 }),
    "a transport failure": () => async () => {
      throw new TypeError("fetch failed");
    },
  };
  for (const [name, broken] of Object.entries(unreadable)) {
    const pool = await stage([streamed()]);
    try {
      const shape = chatOnly(2);
      const run = await runLoad({
        client: pool.client,
        credential: acceptanceCredential(deviceEnv),
        shape,
        clock: testClock(),
        witness: mockWitness({ origin: pool.origin, key: witnessKey, fetch: broken(fetch) }),
      });
      assert.deepEqual(
        run.calls.map((call) => call.classes),
        [["mock_missing"], ["mock_missing"]],
        name,
      );
      assert.deepEqual(run.verdict.witness, { read: false, sends: 0 }, name);
      assert.equal(run.verdict.passed, false, name);
      assert.ok(summaryLines(run, shape).includes("load witness=unread"), name);
    } finally {
      pool.close();
    }
  }
});

test("a run without a witness has no record of any call, and cannot pass", async () => {
  const pool = await stage([streamed()]);
  try {
    const run = await runLoad({
      client: pool.client,
      credential: acceptanceCredential(deviceEnv),
      shape: chatOnly(1),
      clock: testClock(),
    });
    assert.deepEqual(run.calls[0]!.classes, ["mock_missing"]);
    assert.equal(run.verdict.passed, false);
  } finally {
    pool.close();
  }
});

test("the mock's record is read only with its key", async () => {
  const pool = await stage([streamed()]);
  try {
    const wrong = await mockWitness({ origin: pool.origin, key: `${witnessKey}x` }).read(
      "0".repeat(16),
    );
    assert.equal(wrong, undefined);
    assert.deepEqual(await pool.witness.read("0".repeat(16)), []);
  } finally {
    pool.close();
  }
});
