import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Fiber } from "effect";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";

const directory = resolve(
  process.argv[2] ?? join(root, ".generated/pool-reset-checks", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const program = Effect.gen(function* () {
  const h = yield* poolCloudHarness(directory, { resets: true });
  const identity = yield* h.request("GET", "/api/auth/get-session");
  const pool = yield* until(
    h.request("GET", `${h.prefix}/apps`),
    (apps) => apps.some((app) => app.name === `${identity.user.name}'s pool`),
    "native pool provisioning did not finish",
  ).pipe(Effect.map((apps) => apps.find((app) => app.name === `${identity.user.name}'s pool`)));
  yield* until(
    h.request("GET", `${h.appPath(pool.id)}/accounts/app`),
    (links) => links.some((link) => link.requirement === "pool" && link.hostManaged),
    "pool access not linked",
  );
  const methods = yield* h.request("GET", `${h.appPath(pool.id)}/accounts/methods`);
  checked(
    "new pool source has no retained Subscription requirement",
    methods.connections.some((policy) => policy.requirement === "subscriptions"),
    false,
  );
  checked(
    "new pool requirements never acquire credentials",
    methods.connections.every((policy) => policy.canConnect === false),
    true,
  );
  const connect = (id, provider) =>
    Effect.gen(function* () {
      const lab = provider === "codex" ? "openai" : "anthropic";
      const app = yield* h.request("POST", `${h.prefix}/apps/install`, {
        entry: `provider-${lab}`,
        name: `Synthetic ${lab}`,
      });
      h.fixture.prepareAcquisition(null, id, provider);
      const pending = yield* h.request(
        "POST",
        `${h.appPath(app.id)}/accounts/app/${lab}/connections`,
        {},
      );
      const path = `${h.prefix}/connections/${pending.id}/interactive`;
      yield* h.request("POST", `${path}/start`, { method: provider });
      const saved = yield* h.request("GET", `${path}/status`);
      checked("provider-app connection saves through the real host", saved.state, "connected");
      yield* h.request("PUT", `${h.appPath(pool.id)}/accounts/app/${lab}/${saved.account.id}`);
      const target = `${h.prefix}/pools/${pool.id}/accounts/${saved.account.id}`;
      yield* until(
        h.raw("owner", "GET", `${target}/reset-credits`),
        (response) => response.status === 200,
        "saved account membership did not reach the backend",
      );
      return { account: saved.account.id, path: target };
    });
  const codex = yield* connect("synthetic-codex-reset", "codex");
  const catalog = yield* h.request("GET", `${codex.path}/reset-credits`);
  checked("hosted catalog keeps unknown Codex usability", catalog.credits[0].usableNow, null);
  checked(
    "hosted catalog does not expose the backend account reference",
    JSON.stringify(catalog).includes("synthetic-codex-reset"),
    false,
  );
  checked(
    "opening the catalog spends nothing",
    h.fixture.resets.calls.some((call) => call.action === "consume"),
    false,
  );
  const input = { creditId: catalog.credits[0].id, requestId: crypto.randomUUID() };
  checked(
    "member cannot read an owner's reset catalog",
    (yield* h.raw("member", "GET", `${codex.path}/reset-credits`)).status,
    403,
  );
  checked(
    "member cannot spend an owner's reset",
    (yield* h.raw("member", "POST", `${codex.path}/reset`, input)).status,
    403,
  );
  const key = yield* h.request("POST", "/api/auth/api-key/create", {
    name: "Synthetic reset refusal",
  });
  try {
    checked(
      "API credentials cannot use the browser spend route",
      (yield* h.raw("owner", "POST", `${codex.path}/reset`, input, {
        authorization: `Bearer ${key.key}`,
      })).status,
      403,
    );
  } finally {
    yield* h.request("POST", "/api/auth/api-key/delete", { keyId: key.id });
  }
  h.fixture.resets.mode("synthetic-codex-reset", "unknown");
  const held = h.fixture.resets.hold();
  const pending = yield* h.request("POST", `${codex.path}/reset`, input).pipe(Effect.forkChild);
  yield* Effect.promise(() => held.started);
  checked(
    "pending reset sends exactly one provider request",
    h.fixture.resets.calls.filter((call) => call.action === "consume").length,
    1,
  );
  held.release();
  checked("lost provider reply returns unknown", (yield* Fiber.join(pending)).outcome, "unknown");
  h.fixture.restart();
  const recovered = yield* h.request("GET", `${codex.path}/reset-attempt`);
  checked("hosted recovery retains the original request", recovered.requestId, input.requestId);
  checked("hosted recovery permits the original in-window retry", recovered.canRetryProvider, true);
  checked(
    "new request ID is refused while unknown",
    (yield* h.raw("owner", "POST", `${codex.path}/reset`, {
      ...input,
      requestId: crypto.randomUUID(),
    })).status,
    409,
  );
  const confirmed = yield* h.request("POST", `${codex.path}/reset`, input);
  checked(
    "same-ID retry recovers the confirmed provider receipt",
    confirmed.outcome,
    "already_redeemed",
  );
  checked("confirmed reset retains completed cooldown follow-up", confirmed.cooldownCleared, true);
  checked(
    "confirmed reset retains completed refresh follow-up",
    confirmed.usageRefreshQueued,
    true,
  );
  yield* h.request("POST", `${codex.path}/reset`, input);
  checked(
    "confirmed replay never spends again",
    h.fixture.resets.calls.filter((call) => call.action === "consume").length,
    2,
  );
  checked(
    "a fresh hosted catalog reports the remaining credit",
    (yield* h.request("GET", `${codex.path}/reset-credits`)).available,
    1,
  );
  checked(
    "synthetic provider spent only one actual credit",
    h.fixture.resets.remaining("synthetic-codex-reset"),
    1,
  );
  const claude = yield* connect("synthetic-claude-reset", "claude");
  const grants = yield* h.request("GET", `${claude.path}/reset-credits`);
  checked("Claude catalog has known current usability", grants.credits[0].usableNow, true);
  h.fixture.resets.mode("synthetic-claude-reset", "refused");
  checked(
    "definite Claude refusal stays distinct",
    (yield* h.request("POST", `${claude.path}/reset`, {
      creditId: grants.credits[0].id,
      requestId: crypto.randomUUID(),
    })).outcome,
    "not_limited",
  );
  return { checks, syntheticOnly: true, runtimeDirectory: h.runtimeDirectory };
});
try {
  const report = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ checks: checks.length, directory }));
} catch (error) {
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify({ checks, message: String(error) }, null, 2) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
