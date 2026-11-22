import assert from "node:assert/strict";
import { test } from "node:test";
import { readRehearsalMark, releaseMarkOf } from "./rehearsal-mark-read.ts";

const origin = "https://app.rehearsal-6.example.invalid";
// Each read gets a fresh Response: a tee'd clone's cancel waits on its twin.
const answer = (mark: string) => () => Response.json({ mark, unlisted: "rehearsal-unlisted-v1:1" });
const answers = (...responses: (() => Response)[]) => {
  let calls = 0;
  const send = (async () => responses[Math.min(calls++, responses.length - 1)]!()) as typeof fetch;
  return { send, calls: () => calls };
};

test("without an expected mark one read is the answer", async () => {
  const { send, calls } = answers(answer(releaseMarkOf("a".repeat(40))));
  assert.deepEqual(await readRehearsalMark(origin, { send, pause: async () => {} }), {
    mark: `rehearsal-v1:${"a".repeat(40)}`,
    unlisted: "rehearsal-unlisted-v1:1",
    reads: 1,
  });
  assert.equal(calls(), 1);
});

test("it reads again until the edge serves the expected mark", async () => {
  const before = releaseMarkOf("a".repeat(40));
  const after = releaseMarkOf("b".repeat(40));
  const { send } = answers(answer(before), answer(before), answer(after));
  const read = await readRehearsalMark(origin, { expect: after, send, pause: async () => {} });
  assert.deepEqual(read, {
    mark: after,
    unlisted: "rehearsal-unlisted-v1:1",
    reads: 3,
    expected: true,
  });
});

test("a mark that never becomes the expected one says so, with the last mark served", async () => {
  const before = releaseMarkOf("a".repeat(40));
  const { send } = answers(answer(before));
  const read = await readRehearsalMark(origin, {
    expect: releaseMarkOf("b".repeat(40)),
    attempts: 3,
    send,
    pause: async () => {},
  });
  assert.deepEqual(read, {
    mark: before,
    unlisted: "rehearsal-unlisted-v1:1",
    reads: 3,
    expected: false,
  });
});

test("a Router without the marks answers with its status, not a mark", async () => {
  const { send } = answers(() => new Response("tools", { status: 404 }));
  assert.deepEqual(await readRehearsalMark(origin, { attempts: 2, send, pause: async () => {} }), {
    status: 404,
    reads: 2,
  });
});
