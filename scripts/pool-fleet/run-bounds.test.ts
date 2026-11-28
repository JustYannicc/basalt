import assert from "node:assert/strict";
import { test } from "node:test";
import { UserCapReached } from "../pool-acceptance/types.ts";
import { requestLoop } from "./crash-cell.ts";
import { FleetLaneRefused } from "./errors.ts";
import { OwnTraffic, turnBudgets } from "./own-traffic.ts";

const credential = async () => ({ "x-basalt-native-assertion": "fixture" });

function pool(cappedFrom = Number.POSITIVE_INFINITY) {
  const sent: string[] = [];
  const client = {
    modelCatalog: async () => ({ boot: "boot-root", ids: ["model-a"], completedAt: 0 }),
    sendTurn: async () => {
      sent.push("turn");
      if (sent.length > cappedFrom) throw new UserCapReached("cap");
      return { boot: "boot-root", firstByteMs: 1, totalMs: 1 };
    },
    nativeUsage: async () => ({ key: 41, sessions: [] }),
  };
  return { client, sent };
}

const reason = (error: unknown) =>
  error instanceof FleetLaneRefused ? error.reason : String(error);

test("each mode's turns are capped: the turn past the budget is refused and never sent", async () => {
  assert.deepEqual(turnBudgets, { accept: 19, crashCell: 60, rootServes: 1 });
  const { client, sent } = pool();
  const traffic = new OwnTraffic(client, credential, 3);
  for (let turn = 0; turn < 3; turn++) await traffic.turn("model-a");
  assert.equal(traffic.turnsLeft("model-a"), 0);
  await assert.rejects(traffic.turn("model-a"), (error) => reason(error) === "turn-budget");
  assert.equal(sent.length, 3);
});

test("turns started together can't pass the budget, and each model has its own", async () => {
  const { client, sent } = pool();
  const traffic = new OwnTraffic(client, credential, 3);
  const burst = await Promise.allSettled(Array.from({ length: 5 }, () => traffic.turn("model-a")));
  assert.deepEqual(
    burst.map((result) => (result.status === "fulfilled" ? "sent" : reason(result.reason))),
    ["sent", "sent", "sent", "turn-budget", "turn-budget"],
  );
  assert.equal(sent.length, 3);
  assert.equal(traffic.turnsLeft("model-b"), 3);
  await traffic.turn("model-b");
  assert.equal(sent.length, 4);
});

test("the first cap-coded 429 ends the run as could not test and no turn follows it", async () => {
  const { client, sent } = pool(1);
  const traffic = new OwnTraffic(client, credential, turnBudgets.accept);
  await traffic.turn("model-a");
  await assert.rejects(traffic.turn("model-a"), (error) => reason(error) === "could-not-test-cap");
  assert.equal(traffic.capped, true);
  assert.equal(traffic.turnsLeft("model-a"), 0);
  await assert.rejects(traffic.turn("model-a"), (error) => reason(error) === "could-not-test-cap");
  assert.equal(sent.length, 2, "nothing is sent after the cap");
});

test("crash-cell's request loop stops at its time bound even while the proof still runs", async () => {
  let clock = 0;
  const loop = requestLoop({
    request: async () => {},
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    boundMs: 330_000,
  });
  // Nobody calls stop: the loop ends at its bound on its own.
  await loop.done;
  assert.ok(clock >= 330_000 && clock < 332_000, String(clock));
  assert.ok(loop.outcomes.length <= 331, String(loop.outcomes.length));
  await loop.stop();
});
