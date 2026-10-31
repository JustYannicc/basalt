import { Effect } from "effect";
import { until } from "./harness.mjs";

/** Distinct source attempts must span the real thirty-minute threshold before native action. */
export const verifyPoolCheckFailures = (h, pool, scenario, checked) =>
  Effect.gen(function* () {
    const { fixture, channel, copy, checkpoint, scan, read, healthy } = scenario;
    const app = yield* copy("owner", channel);
    fixture.disappear("synthetic-account-f");
    const id = "synthetic-account-g";
    const first = Date.now() - 29 * 60000 - 54000;
    const failed = (attemptedAt, error = "UPSTREAM_AUTH_REJECTED") =>
      fixture.seed(pool.id, id, {
        status: "failed",
        error,
        attemptedAt,
      });
    failed(first);
    yield* read(app);
    checked(
      "one native failed source attempt cannot create a question",
      (yield* checkpoint(app)).question,
      undefined,
    );
    yield* read(app);
    checked(
      "cached native failed source reads do not advance confirmation",
      (yield* checkpoint(app)).observation.poolChecks[0].count,
      1,
    );
    failed(first + 15 * 60000);
    yield* read(app);
    checked(
      "two native failed attempts still await confirmation",
      (yield* checkpoint(app)).observation.poolChecks[0].count,
      2,
    );
    checked(
      "confirmed reads awaiting the threshold remain visible to the watcher",
      (yield* h.call(app.id, "deliveryHealth")).scans[0].known,
      1,
    );
    failed(Date.now(), "UPSTREAM_RATE_LIMITED");
    yield* read(app);
    checked(
      "native provider rate limiting preserves the failure history without a question",
      (yield* checkpoint(app)).question,
      undefined,
    );
    // Complete the synthetic provider's third attempt at the actual source-time threshold.
    fixture.completeCollectionAt(id, first + 30 * 60000 + 1, () => failed(Date.now()));
    yield* scan(app);
    const opening = yield* until(
      checkpoint(app),
      (value) => value.question !== undefined,
      "three native failed checks did not create their waiting item",
    );
    checked(
      "native repeated-check condition opens after three distinct attempts",
      opening.observation.poolChecks[0].count,
      3,
    );
    checked(
      "native repeated-check condition uses the failed-check decision",
      opening.observation.code,
      "pool-account-checks-failed",
    );
    checked(
      "native failed attempts span at least thirty minutes",
      opening.observation.poolChecks[0].attempt - opening.observation.poolChecks[0].since >=
        30 * 60000,
      true,
    );
    const before = fixture.sends.length;
    yield* h.approved(app.id, "configure", { deliveryEnabled: true });
    yield* scan(app);
    yield* until(
      checkpoint(app),
      (value) => value.notified === "sent",
      "confirmed failed checks did not use the configured channel",
    );
    checked("confirmed failed checks nudge the owner once", fixture.sends.length, before + 1);
    yield* read(app);
    checked(
      "cached native confirmation cannot produce another nudge",
      fixture.sends.length,
      before + 1,
    );
    yield* healthy(app, id);
    yield* until(
      h.request("GET", `${h.appPath(app.id)}/workflow-inputs/${opening.question.id}`),
      (value) => value.status === "withdrawn",
      "healthy native checks did not withdraw the failure question",
    );
    checked(
      "healthy native checks close the failed-check episode",
      (yield* checkpoint(app)).open,
      false,
    );
    const confirmation = opening.observation.poolChecks[0];
    return {
      count: confirmation.count,
      firstAttemptAt: confirmation.since,
      lastAttemptAt: confirmation.attempt,
      spanMilliseconds: confirmation.attempt - confirmation.since,
    };
  });
