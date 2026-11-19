import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer } from "effect/sql/Statement";
import {
  apply,
  catalogSource,
  dryRun,
  everything,
  holdNextBuild,
  link,
  listed,
  loadOptional,
  ownerOf,
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

test("the GO locks every app that owns a version it moves", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      // This app's active version declares another provider; an older version names the retained ref.
      const renamed = catalogSource("cloudflare").map((file) =>
        file.path === "index.ts"
          ? {
              ...file,
              content: file.content.replace('name: "Cloudflare",', 'name: "Cloudflare staging",'),
            }
          : file,
      );
      const other = yield* w.install(
        teamA,
        "Second Cloudflare",
        catalogSource("cloudflare.published"),
      );
      const current = yield* w.redeploy(teamA, other.app.id, renamed);
      assert.notEqual(yield* w.requirement(current.version.id), w.retained);
      const { plan, go } = yield* dryRun(w.requestA);
      assert.ok(JSON.stringify(plan.data.deployments).includes(other.version.id));
      const locked: string[] = [];
      const applied = yield* apply(go).pipe(
        Effect.provideService(CurrentTransformer, (statement) =>
          Effect.sync(() => {
            const [text, params] = statement.compile();
            if (/for (?:no key )?update nowait/iu.test(text)) locked.push(...params.map(String));
            return statement;
          }),
        ),
      );
      assert.ok(applied.action === "apply" && applied.repeated === false);
      // Activating that older version or deploying the app waits for the GO and reads moved rows.
      assert.ok(locked.includes(other.app.id), "the GO holds the app's row lock");
      assert.equal(yield* settled(w.requestA), 0);
    }),
  ));

type Guard = {
  readonly requireRequirementProvider: (
    sql: SqlClient.SqlClient,
    target: { readonly app: string; readonly requirement: string },
    account: { readonly owner: string; readonly provider: string },
  ) => Effect.Effect<void, unknown, SqlClient.SqlClient>;
};
test("a token account saved for a requirement after the GO cannot land on the retained ref", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      const guard = (yield* Effect.promise(() =>
        loadOptional("apps/hosted/server/src/implementation/requirement-account-guard.ts"),
      )) as Guard | undefined;
      assert.ok(
        guard,
        "saving an account for a requirement checks the requirement's provider again",
      );
      // The request read the requirement before the GO; its insert transaction runs after it.
      const { go } = yield* dryRun(w.requestA);
      yield* apply(go);
      const statements: string[] = [];
      const save = (provider: string) =>
        reasonOf(
          sql.withTransaction(
            guard.requireRequirementProvider(
              sql,
              { app: w.toolA, requirement: "cloudflare" },
              { owner: ownerOf(teamA), provider },
            ),
          ),
        ).pipe(
          Effect.provideService(CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
      assert.notEqual(yield* save(w.retained), "succeeded", "the retained ref is refused");
      assert.match(
        statements.find((text) => /executor_apps/iu.test(text)) ?? "",
        /^\s*update executor_apps/iu,
        "it takes the app's row lock as deploys do before it reads the requirement",
      );
      assert.equal(yield* save(w.family), "succeeded");
    }),
  ));
