import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  apply,
  dryRun,
  everything,
  holdNextBuild,
  link,
  listed,
  reasonOf,
  run,
  teamA,
  world,
} from "./cloudflare-family-fixture.ts";

// Deploys of the catalog app around the GO, through the real deploy path. The operator's two
// checks after the GO are a dry run with no accounts that must plan zero changes.
const settled = (request: { readonly organization: string }) =>
  dryRun({ ...request, accounts: [] }).pipe(Effect.map(({ dry }) => dry.changes));

test("a GO refuses while a deploy of the app is in flight, and so does a dry run", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      const { go } = yield* dryRun(w.requestA);
      const hold = yield* holdNextBuild(w.holds);
      const deploying = yield* Effect.forkChild(w.redeploy(teamA, w.toolA));
      // The deploy has reserved its order and read the active version; it is still building.
      yield* Deferred.await(hold.reached);
      const before = yield* everything;
      assert.equal(yield* reasonOf(apply(go)), "deploy-in-flight", "the GO runs the check itself");
      assert.deepEqual(yield* everything, before, "nothing moved and no receipt exists");
      assert.equal(yield* reasonOf(dryRun(w.requestA)), "deploy-in-flight");
      yield* Deferred.succeed(hold.release, "built");
      const finished = yield* Fiber.join(deploying);
      assert.equal(yield* w.requirement(finished.version.id), w.retained);
      // Once it has finished, a fresh dry run plans its version too.
      const again = yield* dryRun(w.requestA);
      assert.equal(again.dry.changes, 7);
      yield* apply(again.go);
      assert.equal(yield* settled(w.requestA), 0);
    }),
  ));

test("a failed deploy reads as in flight until the app deploys once more", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      const hold = yield* holdNextBuild(w.holds);
      const deploying = yield* Effect.forkChild(Effect.exit(w.redeploy(teamA, w.toolA)));
      yield* Deferred.await(hold.reached);
      yield* Deferred.succeed(hold.release, "failed");
      assert.ok(Exit.isFailure(yield* Fiber.join(deploying)));
      assert.equal(yield* reasonOf(dryRun(w.requestA)), "deploy-in-flight");
      yield* w.redeploy(teamA, w.toolA);
      assert.equal(yield* reasonOf(dryRun(w.requestA)), "succeeded");
    }),
  ));

test("a deploy that read the retained ref before the GO writes the family ref after it", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      const hold = yield* holdNextBuild(w.holds);
      const slow = yield* Effect.forkChild(w.redeploy(teamA, w.toolA));
      yield* Deferred.await(hold.reached);
      // A later deploy overtakes it and activates, so the app no longer shows a deploy in flight.
      const fast = yield* w.redeploy(teamA, w.toolA);
      assert.equal(yield* w.requirement(fast.version.id), w.retained);
      const { dry, go } = yield* dryRun(w.requestA);
      assert.equal(dry.changes, 7);
      yield* apply(go);
      yield* Deferred.succeed(hold.release, "built");
      const late = yield* Fiber.join(slow);
      assert.equal(
        yield* w.requirement(late.version.id),
        w.family,
        "the deploy continues from the active version as it is under its final lock",
      );
      assert.equal(
        yield* settled(w.requestA),
        0,
        "nothing in the organization names the retained ref",
      );
    }),
  ));

test("the first deploy after the GO keeps the family ref", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      const { go } = yield* dryRun(w.requestA);
      yield* apply(go);
      assert.equal(yield* settled(w.requestA), 0, "the check right after the GO");
      const next = yield* w.redeploy(teamA, w.toolA);
      assert.equal(yield* w.requirement(next.version.id), w.family);
      assert.equal(yield* settled(w.requestA), 0, "the check after the first later deploy");
      assert.deepEqual(yield* listed(w.toolA), ["acc_oauth", "acc_token"]);
      assert.equal(yield* link(w.pipeline, "acc_token"), "linked");
    }),
  ));
