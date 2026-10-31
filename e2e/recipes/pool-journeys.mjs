import { Effect } from "effect";
import { until } from "./harness.mjs";
import { poolRecipeScenario } from "./pool-scenario.mjs";

/** Native pool ownership, disappearance, intent, recovery, and revoked channel authority. */
export const verifyPoolJourneys = (h, pool, checked) =>
  Effect.gen(function* () {
    const scenario = yield* poolRecipeScenario(h, pool);
    const {
      fixture,
      channel,
      channelFiles,
      deployAs,
      copy,
      share,
      key,
      checkpoint,
      scan,
      read,
      healthy,
    } = scenario;
    const app = yield* copy("owner", channel);
    yield* healthy(app, "synthetic-account-a");
    yield* read(app);
    checked(
      "cached native successes refresh scan health when completion follows attempt time",
      (yield* h.call(app.id, "deliveryHealth")).scans[0].known,
      1,
    );
    checked(
      "native pool observations establish the used account baseline",
      (yield* checkpoint(app)).observation.poolMembers[0].inUse,
      true,
    );
    const removed = yield* h.call(
      pool.id,
      "removeAccount",
      { id: "synthetic-account-a" },
      "mutation",
    );
    checked("native owner removal succeeds", removed.ok, true);
    yield* read(app);
    checked(
      "intentional native removal creates no waiting item",
      (yield* checkpoint(app)).question,
      undefined,
    );
    checked("intentional native removal stays quiet", fixture.sends.length, 0);
    yield* healthy(app, "synthetic-account-b");
    fixture.disappear("synthetic-account-b");
    yield* scan(app);
    const missing = yield* until(
      checkpoint(app),
      (value) => value.question !== undefined,
      "missing pool account did not create a native question",
    );
    checked(
      "authoritative account disappearance opens the account-loss condition",
      missing.observation.code,
      "pool-account-no-longer-available",
    );
    checked("pool delivery remains off during dry run", fixture.sends.length, 0);
    yield* h.approved(app.id, "configure", { deliveryEnabled: true });
    yield* scan(app);
    yield* until(
      checkpoint(app),
      (value) => value.notified === "sent",
      "pool nudge did not retain its native receipt",
    );
    checked("pool owner gets one configured synthetic nudge", fixture.sends.length, 1);
    const question = yield* h.request(
      "GET",
      `${h.appPath(app.id)}/workflow-inputs/${missing.question.id}`,
    );
    checked(
      "pool nudge links the committed native waiting item",
      fixture.sends[0].reviewUrl,
      question.reviewUrl,
    );
    yield* read(app);
    checked("duplicate pool scans send once", fixture.sends.length, 1);
    fixture.seed(pool.id, "synthetic-account-c", { fresh: false });
    yield* read(app);
    checked(
      "a stale replacement preserves the missing account baseline",
      (yield* checkpoint(app)).observation.poolMissing[0].id,
      "synthetic-account-b",
    );
    fixture.seed(pool.id, "synthetic-account-c", { remaining: 0 });
    yield* read(app);
    checked(
      "a blocked replacement retains the original question",
      (yield* checkpoint(app)).question.id,
      missing.question.id,
    );
    fixture.seed(pool.id, "synthetic-account-c", { remaining: 0 });
    yield* read(app);
    const acknowledged = yield* h.call(
      pool.id,
      "removeAccount",
      { id: "synthetic-account-b" },
      "mutation",
    );
    checked("owner can acknowledge the already unavailable native account", acknowledged.ok, true);
    yield* read(app);
    const stillExhausted = yield* checkpoint(app);
    checked(
      "acknowledged removal cannot close measured capacity exhaustion",
      stillExhausted.observation.code,
      "pool-exhausted",
    );
    checked(
      "capacity exhaustion retains its existing native waiting item",
      stillExhausted.question?.id,
      missing.question.id,
    );
    yield* healthy(app, "synthetic-account-c");
    yield* until(
      h.request("GET", `${h.appPath(app.id)}/workflow-inputs/${missing.question.id}`),
      (value) => value.status === "withdrawn",
      "fresh pool recovery did not withdraw the native question",
    );
    checked("verified pool recovery closes the episode", (yield* checkpoint(app)).open, false);
    checked("verified pool recovery adds no message", fixture.sends.length, 1);

    const sharedChannel = yield* deployAs("member", "Synthetic shared channel", channelFiles);
    yield* share("member", sharedChannel, "everyone");
    checked(
      "channel use is authorized before revocation",
      yield* h.call(sharedChannel.id, "probe"),
      true,
    );
    const restricted = yield* copy("owner", sharedChannel);
    yield* healthy(restricted, "synthetic-account-c");
    fixture.disappear("synthetic-account-c");
    yield* scan(restricted);
    const waiting = yield* until(
      checkpoint(restricted),
      (value) => value.question !== undefined,
      "revocation case did not create its waiting item",
    );
    yield* share("member", sharedChannel, "private");
    checked(
      "channel revocation takes effect at the public tool boundary",
      (yield* h.raw("owner", "POST", `${h.appPath(sharedChannel.id)}/tools/call`, {
        tool: "probe",
        input: {},
        kind: "query",
      })).status,
      403,
    );
    yield* h.approved(restricted.id, "configure", { deliveryEnabled: true });
    yield* scan(restricted);
    const refused = yield* until(
      checkpoint(restricted),
      (value) => value.notified === "refused",
      "revoked channel access did not refuse the nudge",
    );
    checked(
      "revoked channel access leaves the same native question",
      refused.question.id,
      waiting.question.id,
    );
    checked("revoked channel access submits no message", fixture.sends.length, 1);
    yield* share("member", sharedChannel, "everyone");
    yield* h.approved(restricted.id, "retryRefusedDelivery", { key });
    yield* scan(restricted);
    yield* until(
      checkpoint(restricted),
      (value) => value.notified === "sent",
      "restored channel access did not permit the approved safe retry",
    );
    checked("restored channel access permits one authorized safe retry", fixture.sends.length, 2);
    yield* healthy(restricted, "synthetic-account-d");

    const invalidAccess = yield* Effect.promise(() =>
      fetch(`${fixture.origin}/pool/v1/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: "invalid" }),
      }),
    );
    checked(
      "the production access receiver rejects an unsigned assertion",
      invalidAccess.status,
      401,
    );
    yield* share("owner", pool, "everyone");
    checked(
      "normal sharing reaches the production signed access receiver",
      fixture.accessCalls.includes(200),
      true,
    );
    const memberView = yield* h.callAs("member", pool.id, "view");
    checked("shared pool view keeps native caller ownership", memberView.value.isOwner, false);
    checked(
      "shared pool members cannot read the owner's removal intent",
      Object.hasOwn(memberView.value, "removals"),
      false,
    );
    const denied = yield* h.callAs(
      "member",
      pool.id,
      "removeAccount",
      { id: "synthetic-account-d" },
      "mutation",
    );
    checked("a pool member cannot remove the owner's account", denied.error, "not_owner");
    const memberApp = yield* copy("member", sharedChannel);
    const memberRun = yield* read(memberApp, "member");
    checked(
      "another person's pool cannot become the member's repair task",
      memberRun.output.status,
      "withdrawn",
    );
    checked(
      "non-owner recipe execution creates no question",
      (yield* checkpoint(memberApp, "member")).question,
      undefined,
    );
    yield* share("owner", pool, "private");
    const revokedRun = yield* read(memberApp, "member");
    checked(
      "revoked source access withdraws the member's recipe",
      revokedRun.output.status,
      "withdrawn",
    );
    checked("non-owner and revoked-source runs stay quiet", fixture.sends.length, 2);
    return { ...scenario, sharedChannel };
  });
