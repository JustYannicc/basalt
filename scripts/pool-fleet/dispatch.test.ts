import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { runPoolFleet, stepSummary, type DispatchInput } from "./dispatch.ts";
import { refuse } from "./errors.ts";
import { resolvedApplication } from "./test/cloudflare-shapes.ts";
import { accountId, colours, harness } from "./test/harness.ts";

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
