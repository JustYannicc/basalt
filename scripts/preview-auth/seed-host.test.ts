import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForStageHost } from "./seed.ts";

const clock = () => {
  let t = 0;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

test("the seed waits for the stage host to serve, then goes on", async () => {
  const c = clock();
  const answers: (Response | Error)[] = [
    new Error("unable to verify the first certificate"),
    new Response(null, { status: 404 }),
    new Response("{}", { status: 200 }),
  ];
  let calls = 0;
  await waitForStageHost("https://app.rehearsal-6.example.invalid", {
    boundMs: 60_000,
    everyMs: 1,
    now: c.now,
    send: async () => {
      calls++;
      c.tick(1_000);
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
  });
  assert.equal(calls, 3);
});

test("a host that never serves times out, naming what it last did", async () => {
  const c = clock();
  await assert.rejects(
    waitForStageHost("https://app.rehearsal-6.example.invalid", {
      boundMs: 3_000,
      everyMs: 1,
      now: c.now,
      send: async () => {
        c.tick(1_000);
        return new Response(null, { status: 404 });
      },
    }),
    /did not serve within 3 s \(last: HTTP 404\)/u,
  );
});
