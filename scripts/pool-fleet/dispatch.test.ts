import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { runPoolFleet, stepSummary, type DispatchInput } from "./dispatch.ts";
import { FleetLaneRefused, refuse } from "./errors.ts";
import { resolvedApplication } from "./test/cloudflare-shapes.ts";
import { accountId, colours, harness, ownRow, type HarnessOptions } from "./test/harness.ts";
import { usageRollupInspect } from "../../src/pool/model-history/usage-rollup-auto.ts";
import { captureHoursInspect } from "../../src/pool/model-history/capture-hours-auto.ts";

const go = "coordinator-2026-11-18-fleet-proof";
const dispatch = (mode: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({
  mode,
  go,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  ...extra,
});

test("configure pins each colour with the digest the controller's own observation compares", async () => {
  const lane = await harness();
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      lane.actions.filter((action) => action === "fleet-configure"),
      ["fleet-configure"],
    );
    const record = await lane.configuration.inspect();
    assert.equal(record?.enabled, true);
    for (const app of record!.configuration.applications) {
      const colour = colours[app.color];
      // The controller already accepted these pins against its live read; recompute independently.
      const raw = {
        ...structuredClone(resolvedApplication),
        id: colour.id,
        account_id: accountId,
        name: `pool-runtime-${colour.id}`,
        configuration: {
          ...structuredClone(resolvedApplication.configuration),
          image: `registry.example/${accountId}/pool@${colour.image}`,
        },
        durable_objects: { namespace_id: colour.namespace },
      };
      assert.equal(
        app.applicationConfigDigest,
        await providerDigest(runtimeApplicationSettings(decodeProviderApplication(raw))),
      );
      assert.equal(app.imageDigest, colour.image);
      assert.equal(app.imageInput, colour.input);
      assert.equal(app.applicationVersion, "1");
    }
    // One read by the lane, one by the controller's provider observation inside fleet-configure.
    for (const colour of Object.values(colours))
      assert.equal(
        lane.cloudflareReads.filter((path) =>
          path.endsWith(`/containers/applications/${colour.id}`),
        ).length,
        2,
      );
    assert.equal(record!.configuration.legacy.bootId, "primary-boot");
    assert.equal(record!.configuration.revision, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(accountId));
  } finally {
    await lane.close();
  }
});

test("configure, disable, crash, bookmark and retire-row refuse without a coordinator GO and send nothing", async () => {
  const lane = await harness();
  try {
    for (const mode of [
      "configure-and-accept",
      "disable",
      "crash-cell",
      "bookmark",
      "retire-row",
    ]) {
      for (const bad of ["", "go", "coordinator-<pending>", "yes coordinator-2026-x"]) {
        const result = await runPoolFleet(dispatch(mode, { go: bad }), lane.deps());
        assert.equal(result.ok, false);
        assert.match(String("cause" in result && result.cause), /coordinator-go-missing/u);
      }
    }
    assert.deepEqual(lane.actions, []);
    assert.deepEqual(lane.cloudflareReads, []);
  } finally {
    await lane.close();
  }
});

test("a checkout built from other code than the live Worker is refused by name before any change", async () => {
  const lane = await harness();
  try {
    const deps = lane.deps();
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...deps,
      controller: (name) => ({
        ...deps.controller(name),
        code: { candidate: "9".repeat(40), workerInput: "d".repeat(64) },
      }),
    });
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /controller-code-mismatch/u);
    // configure-and-accept reads through the controller's handover window first; it only reads.
    assert.deepEqual([...new Set(lane.actions)], ["inspect"]);
  } finally {
    await lane.close();
  }
});

test("a rerun with the same GO only inspects, even on a fresh runner", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const again = await runPoolFleet(
      dispatch("configure-and-accept"),
      lane.deps(join(lane.directory, "fresh-runner")),
    );
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(lane.actions.filter((action) => action === "fleet-configure").length, 1);
    assert.match(
      JSON.stringify("result" in again && again.result),
      /"status":"already-configured"/u,
    );
  } finally {
    await lane.close();
  }
});

test("a failed acceptance disables the fleet, proves the root serves, and ends red with the cause", async () => {
  const lane = await harness({ turnStatus: 502 });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /chat\/completions returned HTTP 502/u);
    assert.ok(lane.actions.includes("fleet-disable"));
    assert.equal((await lane.configuration.inspect())?.enabled, false);
    assert.deepEqual((result as { rollback: unknown }).rollback, {
      disabled: {
        status: "disabled",
        operationId: (result as { rollback: { disabled: { operationId: string } } }).rollback
          .disabled.operationId,
      },
      root: { boot: (result as { rollback: { root: { boot: string } } }).rollback.root.boot },
    });
    const summary = stepSummary(result);
    assert.match(summary, /Outcome: \*\*failed\*\*/u);
    assert.match(summary, /Cause: .*HTTP 502/u);
  } finally {
    await lane.close();
  }
});

test("no request served by a fleet cell fails the acceptance and disables the fleet", async () => {
  const lane = await harness({ boot: () => "primary-boot" });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /cell-served-proof-missing/u);
    assert.equal((await lane.configuration.inspect())?.enabled, false);
  } finally {
    await lane.close();
  }
});

/** The first acceptance model refused for funding; the second one's cells serve from `cellFrom` on. */
async function afterRefusal(cellFrom: number | undefined) {
  const lane = await harness({
    models: ["claude-opus-5-5", "gpt-6.1-sol"],
    quota: (model) => (model === "claude-opus-5-5" ? "usage_credit_policy_denied" : undefined),
    boot: (index, enabled) =>
      enabled && cellFrom !== undefined && index >= cellFrom ? "cell-boot" : "primary-boot",
  });
  const deps = lane.deps();
  if (deps.acceptance instanceof FleetLaneRefused) assert.fail(deps.acceptance.message);
  const result = await runPoolFleet(dispatch("configure-and-accept"), {
    ...deps,
    acceptance: { ...deps.acceptance, model: "claude-opus-5-5" },
  });
  return { lane, result };
}

test("after a model refused for quota, the next has all three bursts, and a cell serving in its third passes", async () => {
  // Turns 0-5 are the refused model's; the next model's bursts are turns 6-11, 12-17 and 18-23.
  const { lane, result } = await afterRefusal(18);
  try {
    assert.equal(result.ok, true, JSON.stringify(result));
    const acceptance = ("result" in result && result.result) as {
      acceptance?: { model?: string; quotaRefused?: string[]; servedByCell?: { round: number } };
    };
    assert.equal(acceptance.acceptance?.model, "gpt-6.1-sol");
    assert.equal(acceptance.acceptance?.servedByCell?.round, 3);
    assert.deepEqual(acceptance.acceptance?.quotaRefused, [
      "claude-opus-5-5: usage_credit_policy_denied, HTTP 429",
    ]);
    assert.equal((await lane.configuration.inspect())?.enabled, true);
  } finally {
    await lane.close();
  }
});

test("after a model refused for quota, a next model whose cells never serve ends cell-served-proof-missing and disables the fleet", async () => {
  const { lane, result } = await afterRefusal(undefined);
  try {
    assert.equal(result.ok, false);
    const cause = String("cause" in result && result.cause);
    assert.match(cause, /cell-served-proof-missing/u);
    assert.doesNotMatch(cause, /acceptance-quota-refused|turn-budget/u);
    assert.equal((await lane.configuration.inspect())?.enabled, false);
  } finally {
    await lane.close();
  }
});

test("a fleet read lost after a funding refusal still ends as the quota refusal and keeps the permission", async () => {
  let refused = false;
  const lane = await harness({
    models: ["claude-opus-5-5", "gpt-6.1-sol"],
    quota: (model) => {
      if (model === "claude-opus-5-5") refused = true;
      return "usage_credit_policy_denied";
    },
    handoffFailure: (action) => {
      if (action !== "inspect" || !refused) return undefined;
      refused = false;
      return new Error("synthetic lost read");
    },
    boot: () => "primary-boot",
  });
  try {
    const deps = lane.deps();
    if (deps.acceptance instanceof FleetLaneRefused) assert.fail(deps.acceptance.message);
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...deps,
      acceptance: { ...deps.acceptance, model: "claude-opus-5-5" },
    });
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /acceptance-quota-refused/u);
    assert.equal((await lane.configuration.inspect())?.enabled, true);
  } finally {
    await lane.close();
  }
});

test("a cooldown in a later burst of the next model ends as cooldown-refused and disables the fleet", async () => {
  // The first model is refused for funding; the next one's cells never serve, and the first turn
  // of its third burst is cooled down. A cooldown may be the cell's own node, so the fleet goes off.
  let laterTurns = 0;
  const lane = await harness({
    models: ["claude-opus-5-5", "gpt-6.1-sol"],
    quota: (model) =>
      model === "claude-opus-5-5"
        ? "usage_credit_policy_denied"
        : ++laterTurns === 13
          ? "model_cooldown"
          : undefined,
    boot: () => "primary-boot",
  });
  try {
    const deps = lane.deps();
    if (deps.acceptance instanceof FleetLaneRefused) assert.fail(deps.acceptance.message);
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...deps,
      acceptance: { ...deps.acceptance, model: "claude-opus-5-5" },
    });
    assert.equal(result.ok, false);
    const cause = String("cause" in result && result.cause);
    assert.match(cause, /acceptance-cooldown-refused/u);
    assert.doesNotMatch(cause, /acceptance-quota-refused|turn-budget/u);
    assert.equal((await lane.configuration.inspect())?.enabled, false);
  } finally {
    await lane.close();
  }
});

test("crash-cell refuses when no ready cell other than the primary exists, and sends no crash", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    // The fleet stays enabled, but its only cell is back to warming (a restart in progress).
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as { phase: string }[];
    lane.storage.values.set(
      "runtime-fleet-v1:resources",
      rows.map((row) => ({ ...row, phase: "warming" })),
    );
    assert.equal((await lane.configuration.inspect())?.enabled, true);
    const result = await runPoolFleet(
      dispatch("crash-cell", { go: "coordinator-2026-11-18-crash" }),
      lane.deps(),
    );
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /no-ready-cell/u);
    assert.deepEqual(lane.crashes, []);
    assert.ok(!lane.actions.includes("runtime-crash"));
  } finally {
    await lane.close();
  }
});

test("crash-cell kills one ready non-primary cell, sees it restart, and keeps requests succeeding", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const crash = dispatch("crash-cell", { go: "coordinator-2026-11-18-crash" });
    const sentAfter = Date.now();
    const result = await runPoolFleet(crash, lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(lane.crashes.length, 1);
    assert.equal(lane.crashes[0]!.kind, "cell");
    assert.equal(lane.crashes[0]!.identity.bootId, "cell-boot");
    // The result names the cell it killed and when, by ids alone.
    const killed = lane.crashes[0]!.identity;
    const record = ("result" in result && result.result) as {
      crash?: { target?: unknown; killedAt?: unknown };
    };
    assert.deepEqual(record.crash?.target, {
      slotId: killed.slotId,
      instanceId: killed.instanceId,
      bootId: "cell-boot",
    });
    assert.ok(
      typeof record.crash?.killedAt === "number" &&
        record.crash.killedAt >= sentAfter &&
        record.crash.killedAt <= Date.now(),
    );
    const proof = JSON.stringify("result" in result && result.result);
    assert.match(proof, /"status":"proven"/u);
    assert.match(proof, /"failedAfter":0/u);
    // Its own turns' usage stayed in the device's pool and every response came from a known runtime.
    assert.match(proof, /"ownTraffic":\{"sessions":[1-9]/u);
    // The same GO again reads the retained submission and never sends a second kill.
    const again = await runPoolFleet(crash, lane.deps());
    assert.match(JSON.stringify("result" in again && again.result), /"already-submitted"/u);
    assert.equal(lane.crashes.length, 1);
    // The ready wait, the fleet acceptance and the proof's load each signed for the acceptance
    // device, never with a bearer.
    assert.deepEqual(
      new Set(lane.modelCalls.map(({ call }) => call)),
      new Set(["GET /v1/models", "POST /v1/chat/completions"]),
    );
    for (const { call, authorization, assertion } of lane.modelCalls) {
      assert.equal(authorization, null, call);
      assert.equal(assertion, `assertion ${call}`, call);
    }
  } finally {
    await lane.close();
  }
});

test("bookmark reads the controller storage's current bookmark under a GO and records when", async () => {
  const lane = await harness();
  try {
    const result = await runPoolFleet(
      dispatch("bookmark", { go: "coordinator-2026-11-19T00-00Z-bookmark" }),
      lane.deps(),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const taken = (result as { result: { bookmark: { bookmark: string; at: string } } }).result
      .bookmark;
    assert.equal(taken.bookmark, `0000002a-00000000-00000000-${"c".repeat(32)}`);
    assert.match(taken.at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(lane.actions.includes("storage-bookmark"));
    assert.match(stepSummary(result), /Controller storage bookmark taken at /u);
  } finally {
    await lane.close();
  }
});

test("without an acceptance device the lane refuses the modes that send model calls, and only those", async () => {
  const lane = await harness();
  try {
    const refused = refuse(
      "acceptance-credentials-missing",
      "POOL_ACCEPTANCE_DEVICE: unset.",
      "set the POOL_ACCEPTANCE_DEVICE secret.",
    );
    const deps = { ...lane.deps(), acceptance: refused };
    for (const mode of ["configure-and-accept", "accept", "crash-cell"]) {
      const result = await runPoolFleet(dispatch(mode), deps);
      assert.equal(result.ok, false, mode);
      assert.match(
        String("cause" in result && result.cause),
        /acceptance-credentials-missing: POOL_ACCEPTANCE_DEVICE: unset\. Fix: set the POOL_ACCEPTANCE_DEVICE secret/u,
        mode,
      );
    }
    assert.equal(lane.modelCalls.length, 0, "nothing was sent");
    assert.ok(!lane.actions.includes("fleet-configure"), "nothing was configured");
    assert.equal((await runPoolFleet(dispatch("inspect"), deps)).ok, true);
  } finally {
    await lane.close();
  }
});

test("a usage fault or an unknown boot in the lane's own traffic fails acceptance and rolls the fleet back", async (t) => {
  const outside = { inPool: false, account: null };
  const cases: [string, HarnessOptions, RegExp][] = [
    [
      "another pool's account",
      { usage: (i) => [ownRow(i, i === 3 ? outside : {})] },
      /usage-outside-pool/u,
    ],
    [
      "a failed attempt on another pool's account",
      { usage: (i) => [ownRow(i, { status: "failed", ...outside }), ownRow(i)] },
      /usage-outside-pool/u,
    ],
    ["another key", { usage: (i) => [ownRow(i, i === 2 ? { key: 99 } : {})] }, /usage-other-key/u],
    [
      "two success rows",
      { usage: (i) => (i === 4 ? [ownRow(i), ownRow(100 + i)] : [ownRow(i)]) },
      /usage-duplicate/u,
    ],
    ["no success row", { usage: (i) => (i === 1 ? [] : [ownRow(i)]) }, /usage-missing/u],
    // The route fails closed on a row of another session or key, so that is how another key shows.
    ["a usage read the route refuses", { usageStatus: 503 }, /usage-read-refused/u],
    [
      "an unknown boot",
      { boot: (index, on) => (index === 2 ? "stranger-boot" : on ? "cell-boot" : "primary-boot") },
      /unknown-boot/u,
    ],
  ];
  for (const [name, options, cause] of cases)
    await t.test(name, async () => {
      // Production's shape: no owner token, so the device's own read is the only usage check.
      const lane = await harness({ deviceOnly: true, ...options });
      try {
        const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
        assert.equal(result.ok, false);
        assert.match(String("cause" in result && result.cause), cause);
        assert.equal((await lane.configuration.inspect())?.enabled, false);
        assert.doesNotMatch(JSON.stringify(result), /pool-account-|stranger-boot/u);
      } finally {
        await lane.close();
      }
    });
});

test("crash-cell holds its own traffic to the same isolation rule", async () => {
  let outside = false;
  const lane = await harness({
    deviceOnly: true,
    usage: (i) => [ownRow(i, outside ? { inPool: false, account: null } : {})],
  });
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    outside = true;
    const result = await runPoolFleet(
      dispatch("crash-cell", { go: "coordinator-2026-11-18-crash" }),
      lane.deps(),
    );
    assert.equal(result.ok, false);
    assert.match(String("cause" in result && result.cause), /usage-outside-pool/u);
    assert.equal(lane.crashes.length, 1);
    assert.deepEqual(lane.poolReads, []);
  } finally {
    await lane.close();
  }
});

test("a cap-coded 429 ends configure-and-accept as could not test, and the rollback sends no turn", async () => {
  const lane = await harness({ capped: (index) => index >= 2 });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, false);
    assert.equal("couldNotTest" in result && result.couldNotTest, true);
    assert.match(String("cause" in result && result.cause), /could-not-test-cap/u);
    // One burst was in flight when the cap answered; neither a second burst nor the root check
    // after the disable sent another turn.
    assert.equal(lane.turns(), 6);
    assert.match(stepSummary(result), /could not test/u);
  } finally {
    await lane.close();
  }
});

test("a cap-coded 429 before crash-cell's crash sends no crash and ends could not test", async () => {
  let capped = false;
  const lane = await harness({ capped: () => capped });
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const before = lane.turns();
    capped = true;
    const result = await runPoolFleet(
      dispatch("crash-cell", { go: "coordinator-2026-11-18-crash" }),
      lane.deps(),
    );
    assert.equal(result.ok, false);
    assert.equal("couldNotTest" in result && result.couldNotTest, true);
    assert.equal(lane.crashes.length, 0, "no cell is killed for a run that cannot test");
    assert.equal(lane.turns() - before, 1, "nothing is sent after the cap");
  } finally {
    await lane.close();
  }
});

test("with a device outside a dedicated acceptance pool, the device alone proves the fleet and its own usage, and no owner token is sent", async () => {
  const log: string[] = [];
  const lane = await harness({ deviceOnly: true });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      log: (line) => log.push(line),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // No owner-token read of the pool at all: not its accounts, not its usage.
    assert.deepEqual(lane.poolReads, []);
    // Six turns of the round a cell served, then the final turn: each read back by the device
    // itself, on a pool with many members.
    assert.equal(
      lane.usageReads.reduce((sum, read) => sum + read.sessions, 0),
      7,
    );
    for (const read of lane.usageReads) {
      assert.equal(read.assertion, `assertion GET ${read.path}`);
      assert.equal(read.authorization, null);
    }
    const acceptance = ("result" in result && result.result) as {
      acceptance?: { servedByCell?: unknown; usageRecords?: unknown; ownerUsageRecords?: unknown };
    };
    assert.ok(acceptance.acceptance?.servedByCell, "the served-by-a-cell proof still ran");
    assert.equal(acceptance.acceptance?.usageRecords, 7);
    assert.equal(acceptance.acceptance?.ownerUsageRecords, "skipped");
    assert.ok(
      log.includes(
        "owner_usage_records skipped; the acceptance device is not in a dedicated acceptance pool",
      ),
      log.join("\n"),
    );
    for (const { call, authorization } of lane.modelCalls) assert.equal(authorization, null, call);

    // crash-cell needs only the device's credential.
    const crash = await runPoolFleet(
      dispatch("crash-cell", { go: "coordinator-2026-11-18-crash" }),
      lane.deps(),
    );
    assert.equal(crash.ok, true, JSON.stringify(crash));
    assert.match(JSON.stringify("result" in crash && crash.result), /"status":"proven"/u);
    assert.deepEqual(lane.poolReads, []);
  } finally {
    await lane.close();
  }
});

test("with a dedicated acceptance pool both usage checks cover every one of the lane's turns", async () => {
  const lane = await harness();
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const acceptance = ("result" in result && result.result) as {
      acceptance?: { usageRecords?: unknown; ownerUsageRecords?: unknown };
    };
    assert.equal(acceptance.acceptance?.usageRecords, 7);
    assert.equal(acceptance.acceptance?.ownerUsageRecords, 7);
    // The owner read asks for exactly the sessions the device read back: the six of the round a
    // cell served and the final turn.
    const owner = lane.poolReads.filter((read) => read.path === "/pool/v1/usage");
    const device = lane.usageReads.flatMap((read) =>
      new URL(read.path, "http://local").searchParams.getAll("session"),
    );
    assert.equal(owner.length, 7);
    assert.deepEqual(new Set(owner.map((read) => read.session)), new Set(device));
  } finally {
    await lane.close();
  }
});

test("with a dedicated acceptance pool the usage check still runs and fails on a foreign account", async () => {
  const lane = await harness({ usageAccount: "someone-else" });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, false);
    assert.match(
      String("cause" in result && result.cause),
      /Usage contained an account outside the dedicated test pool/u,
    );
    assert.ok(lane.poolReads.some((read) => read.path === "/pool/v1/usage"));
    assert.ok(lane.usageReads.length > 0, "the device's own read ran first and passed");
    assert.equal(
      (await lane.configuration.inspect())?.enabled,
      false,
      "a failed acceptance disables",
    );
  } finally {
    await lane.close();
  }
});

test("inspect says which acceptance the lane would run, and names no id", async () => {
  for (const [options, expected] of [
    [{}, "full"],
    [{ deviceOnly: true }, "device-only (no dedicated acceptance pool)"],
  ] as const) {
    const log: string[] = [];
    const lane = await harness(options);
    try {
      const result = await runPoolFleet(dispatch("inspect"), {
        ...lane.deps(),
        log: (line) => log.push(line),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        "result" in result && (result.result as { acceptance?: unknown }).acceptance,
        expected,
      );
      assert.ok(log.includes(`acceptance=${expected}`), log.join("\n"));
    } finally {
      await lane.close();
    }
  }
  const lane = await harness();
  try {
    const refused = refuse(
      "acceptance-credentials-missing",
      "POOL_ACCEPTANCE_DEVICE: unset.",
      "Set it.",
    );
    const result = await runPoolFleet(dispatch("inspect"), { ...lane.deps(), acceptance: refused });
    assert.equal(
      "result" in result && (result.result as { acceptance?: unknown }).acceptance,
      "refused (acceptance-credentials-missing)",
    );
  } finally {
    await lane.close();
  }
});

test("the inspect lane shows the pool's own usage rollup backfill as one closed object", async () => {
  // The producer's own projection, through the consumer's decode, as production sends it.
  const usageRollup = usageRollupInspect({
    rollup: "v16",
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow_read",
    lastHour: "2026-08-01T03:00:00.000Z",
    lastHourPhase: "read",
    lastHourReadMs: 5_000,
    pools: 1,
    pendingHours: 2_832,
    totalPendingHours: 3_104,
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-08-01T03:00:00.000Z",
        retryAt: "2026-11-24T09:30:00.000Z",
      },
      { pool: "", reason: "error", retryAt: "2026-11-24T09:30:00.000Z" },
    ],
  });
  // A pool still on the code before the slow hour's readings reports without them.
  const {
    lastHour: _hour,
    lastHourPhase: _phase,
    lastHourReadMs: _readMs,
    totalPendingHours: _total,
    ...older
  } = usageRollup;
  for (const [reported, expected] of [
    [usageRollup, usageRollup],
    [older, older],
    [
      { ...usageRollup, lastHourPhase: "apply" },
      { ...usageRollup, lastHourPhase: "apply" },
    ],
    [{ ...usageRollup, lastHourPhase: "drop table" }, null],
    // The active rollup is a closed name: v15 and v16 pass, an unknown one drops the field.
    [
      { ...usageRollup, rollup: "v15" },
      { ...usageRollup, rollup: "v15" },
    ],
    [{ ...usageRollup, rollup: "unknown" }, null],
    [undefined, null],
    // A shape this lane doesn't know is dropped, and the lane still answers.
    [{ lastStop: 7 }, null],
  ] as const) {
    const lane = await harness(reported === undefined ? {} : { usageRollup: reported });
    try {
      const result = await runPoolFleet(dispatch("inspect"), lane.deps());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(
        "result" in result && (result.result as { usageRollup?: unknown }).usageRollup,
        expected,
      );
      assert.doesNotMatch(JSON.stringify(result), new RegExp(accountId));
    } finally {
      await lane.close();
    }
  }
});

test("the inspect lane shows the pool's own capture-hour counts as one closed object", async () => {
  // The producer's own projection, through the consumer's decode, as production sends it.
  const captureHours = captureHoursInspect({
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow",
    lastHour: "2026-11-01T03:00:00Z",
    lastHourReadMs: 1_000,
    pools: 1,
    pendingBlocks: 5,
    planMs: 412.5,
    pendingHours: 30,
    stalestCheckedAt: "2026-11-20T01:00:00.000Z",
    recountPosition: { pool: "0123456789abcdef", block: "2026-11-01T00:00:00Z" },
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-11-01T03:00:00Z",
        retryAt: "2026-11-23T09:40:00.000Z",
      },
      { pool: "", reason: "error", retryAt: "2026-11-23T10:30:00.000Z" },
    ],
    slow: [
      {
        pool: "0123456789abcdef",
        hour: "2026-11-01T03:00:00Z",
        count: 3,
        until: "2026-11-23T09:40:00.000Z",
      },
    ],
    lastSlow: [
      {
        pool: "0123456789abcdef",
        at: "2026-11-23T09:30:00.000Z",
        hour: "2026-11-01T03:00:00Z",
        block: "2026-11-01T00:00:00Z",
        limit: "count",
        elapsedMs: 1_003,
        repeat: 3,
      },
    ],
    byPool: [{ pool: "0123456789abcdef", pendingBlocks: 5, pendingHours: 30 }],
  });
  assert.equal(captureHours.byPool[0]?.lastSlow?.limit, "count", "the fixture carries a pool");
  // A pool whose projection lacks the optional readings still prints the rest.
  const {
    lastHour: _hour,
    lastHourReadMs: _ms,
    stalestCheckedAt: _stalest,
    pendingBlocks: _blocks,
    planMs: _planMs,
    recountPosition: _position,
    byPool: _byPool,
    ...older
  } = captureHours;
  for (const [reported, expected] of [
    [captureHours, captureHours],
    [older, older],
    [undefined, null],
    // A shape this lane doesn't know is dropped, and the lane still answers.
    [{ ...captureHours, stuck: [{ pool: "fixture-pool-name" }] }, null],
    [{ ...captureHours, recountPosition: { pool: "fixture-pool-name", block: "x" } }, null],
    [{ ...captureHours, planMs: "fast" }, null],
    [{ lastStop: 7 }, null],
  ] as const) {
    const lane = await harness(reported === undefined ? {} : { captureHours: reported });
    try {
      const result = await runPoolFleet(dispatch("inspect"), lane.deps());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(
        "result" in result && (result.result as { captureHours?: unknown }).captureHours,
        expected,
      );
      assert.doesNotMatch(JSON.stringify(result), new RegExp(accountId));
    } finally {
      await lane.close();
    }
  }
});

test("retire-row sends one fleet-retire for the named draining row and prints it before and after", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    // The row a lost release left counting: draining, six calls that never end.
    lane.storage.values.set(
      "runtime-fleet-v1:resources",
      rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
    );
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    const retireGo = "coordinator-2026-11-24-retire-stuck-row";
    const result = await runPoolFleet(dispatch("retire-row", { go: retireGo, key }), lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      lane.retires.map((sent) => [sent.go, sent.key]),
      [[retireGo, key]],
    );
    const outcome = (
      result as unknown as {
        result: {
          before: { key: string; phase: string; active: number }[];
          after: { active: number }[];
          retired: {
            overrode: {
              ledger: number;
              cell: number;
              cellStillMs: number;
              connections: number | null;
            } | null;
          };
        };
      }
    ).result;
    assert.deepEqual(
      outcome.before.map((row) => [row.key.slice(0, 8), row.phase, row.active]),
      [[key, "draining", 6]],
    );
    assert.deepEqual(
      outcome.after.map((row) => row.active),
      [0],
    );
    assert.deepEqual(
      [
        outcome.retired.overrode?.ledger,
        outcome.retired.overrode?.cell,
        outcome.retired.overrode?.cellStillMs,
      ],
      [6, 6, 2_400_000],
    );
    assert.equal(
      outcome.retired.overrode?.connections,
      0,
      "the 8317 connection read is printed beside the counts",
    );
    assert.equal((result as unknown as { result: { warning: unknown } }).result.warning, null);
    assert.doesNotMatch(
      JSON.stringify(result),
      /runtime-cell-1|cell-boot/u,
      "only keys leave, never slot ids",
    );
  } finally {
    await lane.close();
  }
});

test("retire-row refuses a ready row, a bad key and a key matching no row before any send", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    const retireGo = "coordinator-2026-11-24-retire-stuck-row";
    for (const [name, value, refusal] of [
      ["the ready row", key, /row-not-draining/u],
      ["a key too short", key.slice(0, 7), /row-key-invalid/u],
      ["a key matching no row", "00000000", /row-key-ambiguous/u],
    ] as const) {
      const result = await runPoolFleet(
        dispatch("retire-row", { go: retireGo, key: value }),
        lane.deps(),
      );
      assert.equal(result.ok, false, name);
      assert.match(String("cause" in result && result.cause), refusal, name);
    }
    assert.deepEqual(lane.retires, []);
  } finally {
    await lane.close();
  }
});

test("retire-row says plainly when the cell's connection read doesn't show it idle", async () => {
  for (const [connections, warning] of [
    [2, "2 connections are open on this cell; the override may cut them"],
    [null, "the connection read failed; nothing proves this cell is idle"],
  ] as const) {
    const lane = await harness();
    try {
      assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
      const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
        target: { slotId: string };
      }[];
      lane.storage.values.set(
        "runtime-fleet-v1:resources",
        rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
      );
      lane.retireRead.connections = connections;
      const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
      const result = await runPoolFleet(
        dispatch("retire-row", { go: "coordinator-2026-11-24-retire-stuck-row", key }),
        lane.deps(),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((result as unknown as { result: { warning: unknown } }).result.warning, warning);
    } finally {
      await lane.close();
    }
  }
});

test("configure-and-accept sets the target-active it is given, and inspect shows it with the revision and maximum", async () => {
  const lane = await harness();
  try {
    const permission = async () =>
      (
        (await runPoolFleet(dispatch("inspect"), lane.deps())) as unknown as {
          result: {
            fleet: { permission: { revision: number; targetActive: number; maximum: number } };
          };
        }
      ).result.fleet.permission;
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const first = await permission();
    assert.deepEqual([first.revision, first.targetActive, first.maximum], [1, 25, 4]);
    const lowered = await runPoolFleet(
      dispatch("configure-and-accept", {
        go: "coordinator-2026-11-25-target-5",
        targetActive: "5",
      }),
      lane.deps(),
    );
    assert.equal(lowered.ok, true, JSON.stringify(lowered));
    assert.deepEqual([(await permission()).revision, (await permission()).targetActive], [2, 5]);
    const restored = await runPoolFleet(
      dispatch("configure-and-accept", {
        go: "coordinator-2026-11-25-target-25",
        targetActive: "25",
      }),
      lane.deps(),
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual([(await permission()).revision, (await permission()).targetActive], [3, 25]);
  } finally {
    await lane.close();
  }
});

test("a target-active out of configure's range, or on another mode, is refused before any send", async () => {
  const lane = await harness();
  try {
    for (const [mode, value] of [
      ["configure-and-accept", "0"],
      ["configure-and-accept", "100001"],
      ["configure-and-accept", "5.5"],
      ["configure-and-accept", "five"],
      ["inspect", "5"],
    ] as const) {
      const result = await runPoolFleet(dispatch(mode, { targetActive: value }), lane.deps());
      assert.equal(result.ok, false, `${mode} ${value}`);
      assert.match(String("cause" in result && result.cause), /target-active-invalid/u);
    }
    assert.deepEqual(lane.actions, []);
  } finally {
    await lane.close();
  }
});

test("retire-check takes any go text, reports what retire-row would do and whose leases they are, and changes nothing", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    lane.storage.values.set(
      "runtime-fleet-v1:resources",
      rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
    );
    const before = JSON.stringify(lane.storage.values.get("runtime-fleet-v1:resources"));
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    lane.retireRead.connections = 1;
    const result = await runPoolFleet(dispatch("retire-check", { go: "", key }), lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const outcome = (
      result as unknown as {
        result: {
          check: {
            wouldProceed: boolean;
            ledger: number;
            cell: number;
            connections: number;
            leaseOwner: string;
          };
          warning: string | null;
        };
      }
    ).result;
    assert.deepEqual(
      [
        outcome.check.wouldProceed,
        outcome.check.ledger,
        outcome.check.cell,
        outcome.check.connections,
      ],
      [true, 6, 6, 1],
    );
    assert.equal(
      outcome.check.leaseOwner,
      "none of the cell's leases is held by its current instance: 6 unstamped leases from before the stamps, which the proof release ends only when 8317 reads 0",
    );
    assert.equal(outcome.warning, "1 connections are open on this cell; the override may cut them");
    assert.deepEqual(lane.checks, [key]);
    assert.deepEqual(lane.retires, [], "no override was sent");
    assert.equal(JSON.stringify(lane.storage.values.get("runtime-fleet-v1:resources")), before);
    assert.doesNotMatch(JSON.stringify(result), /runtime-cell-1|cell-boot/u);
  } finally {
    await lane.close();
  }
});

test("a configure rerun under the same GO with another target-active is refused instead of silently not applied", async () => {
  const lane = await harness();
  try {
    const go = "coordinator-2026-11-25-target-5";
    assert.equal(
      (await runPoolFleet(dispatch("configure-and-accept", { go, targetActive: "5" }), lane.deps()))
        .ok,
      true,
    );
    const rerun = await runPoolFleet(
      dispatch("configure-and-accept", { go, targetActive: "25" }),
      lane.deps(),
    );
    assert.equal(rerun.ok, false);
    assert.match(String("cause" in rerun && rerun.cause), /target-active-differs/u);
    const kept = await lane.configuration.inspect();
    assert.deepEqual([kept?.configuration.targetActive, kept?.enabled], [5, true]);
    assert.ok(
      !lane.actions.includes("fleet-disable"),
      "a refused input never rolls the fleet back",
    );
  } finally {
    await lane.close();
  }
});

test("retire-check on a ready row reports the refusal and warns about nothing", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    lane.retireRead.connections = 1;
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    const result = await runPoolFleet(dispatch("retire-check", { go: "", key }), lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const outcome = (
      result as unknown as {
        result: { check: { wouldProceed: boolean; refusal: string }; warning: unknown };
      }
    ).result;
    assert.deepEqual([outcome.check.wouldProceed, outcome.check.refusal], [false, "not_draining"]);
    assert.equal(outcome.warning, null, "a ready row's connections are its live traffic");
  } finally {
    await lane.close();
  }
});

test("retire-check names model sockets, unstamped leases and a count with no lease record apart", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    lane.storage.values.set(
      "runtime-fleet-v1:resources",
      rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
    );
    lane.retireRead.leases = {
      currentCalls: 0,
      currentSockets: 0,
      foreignSockets: 1,
      unstamped: 3,
    };
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    const result = await runPoolFleet(dispatch("retire-check", { go: "", key }), lane.deps());
    assert.equal(
      (result as unknown as { result: { check: { leaseOwner: string } } }).result.check.leaseOwner,
      "none of the cell's leases is held by its current instance: 1 model sockets another instance took, which can outlive it, 3 unstamped leases from before the stamps, which the proof release ends only when 8317 reads 0; 2 counted with no lease record, which only the override ends",
    );
  } finally {
    await lane.close();
  }
});

test("retire-check says when the cell's current instance holds leases, by kind", async () => {
  const lane = await harness();
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    const rows = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { slotId: string };
    }[];
    lane.storage.values.set(
      "runtime-fleet-v1:resources",
      rows.map((row) => ({ ...row, phase: "draining", active: 6 })),
    );
    lane.retireRead.leases = {
      currentCalls: 2,
      currentSockets: 1,
      foreignSockets: 0,
      unstamped: 3,
    };
    const key = createHash("sha256").update(rows[0]!.target.slotId).digest("hex").slice(0, 8);
    const result = await runPoolFleet(dispatch("retire-check", { go: "", key }), lane.deps());
    assert.equal(
      (result as unknown as { result: { check: { leaseOwner: string } } }).result.check.leaseOwner,
      "3 of the cell's leases belong to its current instance (2 calls, 1 model sockets), so their streams may be live; the override refuses them",
    );
  } finally {
    await lane.close();
  }
});
