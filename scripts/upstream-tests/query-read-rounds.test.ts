import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { askWithOneReadAgain, readRounds } from "../../.upstream/e2e/support/query-read-rounds.ts";

const server = "1111111111111111";
const span = (operationName: string, parentSpanId: string | null = server) => ({
  operationName,
  parentSpanId,
});

test("each read of a query is one data query directly under its server span", () => {
  const once = [span("http.server POST", null), span("sdk.data.query"), span("catalog.lookup")];
  assert.equal(readRounds(once, server), 1);
  assert.equal(readRounds([...once, span("sdk.data.query")], server), 2);
  // A data query nested deeper belongs to that read, not to a second one.
  assert.equal(readRounds([...once, span("sdk.data.query", "2222222222222222")], server), 1);
});

const run = (rounds: readonly number[]) => {
  const asked: number[] = [];
  const exit = Effect.runSyncExit(
    askWithOneReadAgain((attempt) =>
      Effect.sync(() => {
        asked.push(attempt);
        return { rounds: rounds[attempt]!, answer: `answer ${attempt}` };
      }),
    ),
  );
  return { asked, exit };
};

test("a query that read once is asked once", () => {
  const { asked, exit } = run([1]);
  assert.deepEqual(asked, [0]);
  assert.deepEqual(exit, Exit.succeed("answer 0"));
});

test("a request that read again is asked once more, and that answer is kept", () => {
  const { asked, exit } = run([2, 1]);
  assert.deepEqual(asked, [0, 1]);
  assert.deepEqual(exit, Exit.succeed("answer 1"));
});

test("a request that read three times is also asked once more", () => {
  const { asked, exit } = run([3, 1]);
  assert.deepEqual(asked, [0, 1]);
  assert.deepEqual(exit, Exit.succeed("answer 1"));
});

test("a second read-again in a row fails and names the moved head", () => {
  const { asked, exit } = run([2, 3]);
  assert.deepEqual(asked, [0, 1]);
  assert.ok(Exit.isFailure(exit));
  assert.match(
    String(exit.cause),
    /read again after its account head moved on two requests in a row \(2 and 3 reads\)/u,
  );
});
