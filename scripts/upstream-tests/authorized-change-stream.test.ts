import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Stream } from "effect";
import { authorizedChangeEvents } from "../../.upstream/apps/hosted/server/src/implementation/authorized-change-stream.ts";
import type { RevisionEvent } from "../../.upstream/packages/app-data/src/contracts/change-revisions.ts";

const key = { topic: "deployment", resource: "app-a" };
const current = {
  kind: "current",
  revisions: [{ ...key, revision: "0" }],
  snapshotRequired: true,
} as const;

test("revoked authority receives no private hint on its already-open stream", async () => {
  let allowed = true;
  const events = Stream.make(current).pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.sync(() => {
          allowed = false;
          return { kind: "changed", hint: { ...key, revision: "1" } } satisfies RevisionEvent;
        }),
      ),
    ),
  );
  const received = await Effect.runPromise(
    authorizedChangeEvents({
      keys: [key],
      events,
      current: Effect.succeed(current.revisions),
      authorize: Effect.suspend(() => (allowed ? Effect.void : Effect.fail("revoked"))),
    }).pipe(
      Stream.catch(() => Stream.make({ kind: "revoked" })),
      Stream.runCollect,
    ),
  );
  assert.deepEqual(received, [current, { kind: "revoked" }]);
});

test("registration precedes the SQL head and stale owner state cannot hide an undelivered committed revision", async () => {
  const sequence: string[] = [];
  const received = await Effect.runPromise(
    authorizedChangeEvents({
      keys: [key],
      events: Stream.fromEffect(
        Effect.sync(() => {
          sequence.push("registered");
          return current;
        }),
      ),
      current: Effect.sync(() => {
        sequence.push("SQL head");
        return [{ ...key, revision: "2" }];
      }),
      authorize: Effect.sync(() => {
        sequence.push("authority");
      }),
    }).pipe(Stream.runCollect),
  );
  assert.deepEqual(sequence, ["registered", "SQL head", "authority"]);
  assert.deepEqual(received, [
    { kind: "current", revisions: [{ ...key, revision: "2" }], snapshotRequired: true },
  ]);
});
