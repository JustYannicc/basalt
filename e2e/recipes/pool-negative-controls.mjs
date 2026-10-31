import assert from "node:assert/strict";
import { Effect } from "effect";
import { until } from "./harness.mjs";

/** Intentionally damaged private copies must fail the same native outcome assertions. */
export const verifyPoolNegativeControls = (h, pool, scenario, checked) =>
  Effect.gen(function* () {
    const { fixture, channel, sharedChannel, copy, share, key, checkpoint, scan, read, healthy } =
      scenario;
    const failures = [];
    const rejects = (name, actual, expected) => {
      let failure;
      try {
        assert.deepEqual(actual, expected, name);
      } catch (error) {
        failure = error;
      }
      assert.equal(
        failure?.code,
        "ERR_ASSERTION",
        "the negative control must fail its native outcome assertion",
      );
      failures.push({ name, actual, expected, code: failure.code });
      checked(name, failure.code, "ERR_ASSERTION");
    };
    const violate = (path, before, after) => (file) => {
      if (file.path !== path) return file;
      assert.equal(
        file.content.split(before).length,
        2,
        "the negative control must change its exact branch once",
      );
      return { ...file, content: file.content.replace(before, after) };
    };
    const brokenLoss = yield* copy(
      "owner",
      channel,
      violate(
        "pool-owner/account-condition.ts",
        "const loss = impaired && !overflow ? pending.sort((a, b) => a.id.localeCompare(b.id)) : [];",
        "const loss = [];",
      ),
    );
    yield* healthy(brokenLoss, "synthetic-account-d");
    fixture.disappear("synthetic-account-d");
    yield* read(brokenLoss);
    rejects(
      "negative control catches suppressed native pool waiting item",
      (yield* checkpoint(brokenLoss)).question !== undefined,
      true,
    );

    const brokenRefusal = yield* copy(
      "owner",
      sharedChannel,
      violate("common/delivery.ts", "beforeSubmission.has(error.reason)", "false"),
    );
    yield* healthy(brokenRefusal, "synthetic-account-e");
    fixture.disappear("synthetic-account-e");
    yield* scan(brokenRefusal);
    yield* until(
      checkpoint(brokenRefusal),
      (value) => value.question !== undefined,
      "refusal control did not create a native waiting item",
    );
    yield* share("member", sharedChannel, "private");
    yield* Effect.addFinalizer(() => share("member", sharedChannel, "everyone").pipe(Effect.orDie));
    const before = fixture.sends.length;
    yield* h.approved(brokenRefusal.id, "configure", { deliveryEnabled: true });
    yield* scan(brokenRefusal);
    const refusal = yield* until(
      checkpoint(brokenRefusal),
      (value) => ["refused", "uncertain"].includes(value.notified),
      "refusal control did not retain its native result",
    );
    rejects(
      "negative control catches loss of safe native refusal classification",
      refusal.notified,
      "refused",
    );
    checked(
      "damaged refusal handling still cannot bypass connector access",
      fixture.sends.length,
      before,
    );
    yield* healthy(brokenRefusal, "synthetic-account-f");
    return failures;
  });
