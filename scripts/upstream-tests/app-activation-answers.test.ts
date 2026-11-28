import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { observeAppActivation } from "../../.upstream/e2e/support/app-activation-observer.ts";

type Page = Parameters<typeof observeAppActivation>[0];
type Response = Parameters<Parameters<typeof observeAppActivation>[1]>[0];

const page = () => {
  const events = new EventEmitter();
  return {
    events,
    page: {
      on: (name: string, listener: (value: unknown) => void) => events.on(name, listener),
      off: (name: string, listener: (value: unknown) => void) => events.off(name, listener),
      evaluate: () => Promise.resolve(),
    } as unknown as Page,
  };
};
const answer = (path: string, body: string | undefined) =>
  ({
    url: () => `http://h.test${path}`,
    // An undefined body stands for a stream that never completes.
    text: () => (body === undefined ? new Promise(() => {}) : Promise.resolve(body)),
  }) as unknown as Response;
// The batch host writes one ndjson line per read, each endpoint's body as a JSON string.
const batch = (...bodies: unknown[]) =>
  bodies
    .map((body, id) =>
      JSON.stringify({
        id,
        status: 200,
        contentType: "application/json",
        text: JSON.stringify(body),
      }),
    )
    .join("\n");
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the dashboard's answers are kept as which read and whether it carried the version", async () => {
  const { events, page: fake } = page();
  const observer = observeAppActivation(
    fake,
    () => true,
    () => 0,
    "a",
  );
  const before = batch(
    { app: { id: "a", activeVersion: "v_old" } },
    { apps: [{ id: "b", activeVersion: "v_other" }] },
  );
  events.emit("response", answer("/api/dashboard/batch", before));
  await settle();
  const waited = observer.waitForVersion("v_new");
  events.emit("response", answer("/api/dashboard/batch", before));
  events.emit("response", answer("/api/dashboard/batch", undefined));
  events.emit(
    "response",
    answer("/api/dashboard/batch", batch({ app: { id: "a", activeVersion: "v_new" } })),
  );
  await waited;
  const answers = observer.answers();
  assert.deepEqual(
    answers.map(({ read, bodyCompleted, carriedExpectedVersion, otherVersions }) => ({
      read,
      bodyCompleted,
      carriedExpectedVersion,
      otherVersions,
    })),
    [
      // Another app's version in the same batch is not counted.
      { read: "batch", bodyCompleted: true, carriedExpectedVersion: false, otherVersions: 1 },
      { read: "batch", bodyCompleted: true, carriedExpectedVersion: false, otherVersions: 1 },
      { read: "batch", bodyCompleted: false, carriedExpectedVersion: null, otherVersions: 0 },
      { read: "batch", bodyCompleted: true, carriedExpectedVersion: true, otherVersions: 0 },
    ],
  );
  // Answers before the wait began say so; the wait's own answers are timed from its start.
  assert.ok(answers[0]!.afterWaitBeganMs! <= 0);
  assert.ok(answers[3]!.afterWaitBeganMs! >= 0);
  // The record never keeps a body or a version.
  assert.ok(!/activeVersion|v_old|v_new/u.test(JSON.stringify(answers)));
});
