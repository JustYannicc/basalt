import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { runPoolFleet, stepSummary, type DispatchInput } from "./dispatch.ts";
import { refuse } from "./errors.ts";
import { resolvedApplication } from "./test/cloudflare-shapes.ts";
import { accountId, colours, harness, ownRow, type HarnessOptions } from "./test/harness.ts";

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

test("configure, disable, crash and bookmark refuse without a coordinator GO and send nothing", async () => {
  const lane = await harness();
  try {
    for (const mode of ["configure-and-accept", "disable", "crash-cell", "bookmark"]) {
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
    assert.deepEqual(lane.actions, ["inspect"]);
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
