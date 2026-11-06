import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import { fixture, implementation, load } from "./pool-access-fixture.ts";

const { acknowledgePoolChange } = await load(`${implementation}pool-receiver.ts`);
const Nonce = Schema.Struct({ nonce: Schema.String.check(Schema.isUUID(4)) });

test("local pool signing failure stays StorageError without sending to the receiver", async () => {
  await fixture(({ origin, changes }) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        acknowledgePoolChange(
          Redacted.make("invalid-signing-key"),
          origin,
          "/pool/v1/access",
          "sba1",
          { action: "pool-deleted", pool: "app_pool-fixture" },
          2,
        ),
      );
      assert.equal(result._tag, "Failure");
      const failure = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))(
        result.failure,
      );
      assert.equal(failure._tag, "StorageError");
      assert.equal(changes.length, 0);
    }),
  );
});

test("pool acknowledgement retries sign a new nonce for each send", async () => {
  await fixture(({ hook, changes, loseAcknowledgement }) =>
    Effect.gen(function* () {
      loseAcknowledgement();
      yield* hook.appRemoving("app_pool-fixture");
      assert.equal(changes.length, 2);
      const nonces = changes.map(
        (change: unknown) => Schema.decodeUnknownSync(Nonce)(change).nonce,
      );
      assert.notEqual(nonces[0], nonces[1]);
    }),
  );
});
