import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import {
  awaitRecoveryReady,
  bootBeforeApply,
  healingOutcome,
  NOT_SERVING,
  healingWait,
  runAcceptance,
  servingBoot,
} from "./acceptance.ts";
import {
  healingAcceptanceWithinMs,
  healingReadinessWithinMs,
} from "../../src/pool/runtime-slots/forced-restart-timing.ts";
import { stopPaths } from "./stop-path.ts";
import { AcceptanceDeviceRefused } from "./acceptance-device.ts";
import { failureReport } from "./public-report.ts";

// The local pool checks no identity; acceptance-device tests prove what the real pool checks.
const credential = async () => ({ "x-basalt-native-assertion": "fixture" });

// A pool endpoint speaking the real wire: /v1/models JSON and a streamed chat completion, each with
// the serving runtime's boot header, as the live pool answers the repo's acceptance client.
async function pool(
  options: {
    fail?: number;
    boots?: string[];
    /** HTTP status per chat number, or for the catalog: the pool refusing or failing that call. */
    answer?: Partial<Record<number | "catalog", number>>;
  } = {},
) {
  let chats = 0;
  const server = createServer((request, response) => {
    const boot = options.boots?.[chats % options.boots.length] ?? "boot-root";
    const status = options.answer?.[request.url === "/v1/models" ? "catalog" : chats + 1];
    if (status !== undefined) {
      if (request.url !== "/v1/models") chats++;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized", message: "refused" }));
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-signalbox-pool-boot": "boot-root",
      });
      response.end(JSON.stringify({ object: "list", data: [{ id: "model-a", object: "model" }] }));
      return;
    }
    chats++;
    if (options.fail !== undefined && chats === options.fail) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "busy" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "x-signalbox-pool-boot": boot });
    response.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    client: new PoolAcceptanceClient({ origin: `http://127.0.0.1:${port}` }),
    chats: () => chats,
    close: () => server.close(),
  };
}

test("27 streamed requests on one unchanged root pass a code-only release", async () => {
  const live = await pool();
  try {
    const result = await runAcceptance({ credential, expect: "same-boot", client: live.client });
    assert.equal(result.passed, true, result.cause ?? "");
    assert.equal(live.chats(), 27);
    assert.deepEqual(result.boots, ["boot-root"]);
  } finally {
    live.close();
  }
});

test("one failed request in the burst fails the release and names it", async () => {
  const live = await pool({ fail: 9 });
  try {
    const result = await runAcceptance({ credential, expect: "same-boot", client: live.client });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /1 of 27 requests failed: .*503/u);
  } finally {
    live.close();
  }
});

test("a root that changed boot fails a code-only release", async () => {
  const live = await pool({ boots: ["boot-root", "boot-new"] });
  try {
    const result = await runAcceptance({ credential, expect: "same-boot", client: live.client });
    assert.match(result.cause ?? "", /changed boot/u);
  } finally {
    live.close();
  }
});

test("the fleet passes only when a second runtime served", async () => {
  const root = await pool();
  try {
    const result = await runAcceptance({
      credential,
      expect: "two-runtimes",
      client: root.client,
    });
    assert.match(result.cause ?? "", /no fleet cell served/u);
  } finally {
    root.close();
  }
  const fleet = await pool({ boots: ["boot-root", "boot-cell-1"] });
  try {
    assert.equal(
      (await runAcceptance({ credential, expect: "two-runtimes", client: fleet.client })).passed,
      true,
    );
  } finally {
    fleet.close();
  }
});

test("a root that restarted during the apply fails acceptance, so the release rolls back", async () => {
  const live = await pool({ boots: ["boot-root-new"] });
  try {
    const before = "boot-root";
    const result = await runAcceptance({
      credential,
      expect: "same-boot",
      rootBoot: before,
      client: live.client,
    });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /The root restarted: boot boot-root before the apply/u);
  } finally {
    live.close();
  }
});

test("the root's boot read before the apply passes when the root kept it", async () => {
  const live = await pool();
  try {
    const before = await servingBoot(credential, live.client);
    assert.equal(before, "boot-root");
    const result = await runAcceptance({
      credential,
      expect: "same-boot",
      rootBoot: before,
      client: live.client,
    });
    assert.equal(result.passed, true, result.cause ?? "");
  } finally {
    live.close();
  }
});

test("with fleet cells serving, the root's boot must still be among the runtimes", async () => {
  const live = await pool({ boots: ["boot-cell-1", "boot-cell-2"] });
  try {
    const result = await runAcceptance({
      credential,
      expect: "any",
      rootBoot: "boot-root-gone",
      client: live.client,
    });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /The root restarted/u);
  } finally {
    live.close();
  }
});

// A clock the wait advances itself, so the bound is exercised without waiting it out.
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (milliseconds: number) => void (at += milliseconds) };
};
/** `inspect` replies in turn: an Error is a refusal, anything else the reply's result. */
const replies = (...script: unknown[]) => {
  let reads = 0;
  return {
    reads: () => reads,
    inspect: async () => {
      const next = script[Math.min(reads++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
};
const inspected = (bootId: string, recovery: Record<string, unknown> = {}) => ({
  selection: { active: { identity: { bootId } } },
  recovery,
});

test("a healing release waits for recovery ready: a new boot, no restart pending, no person needed", async () => {
  const controller = replies(
    // The new controller refuses on identity until it has adopted its code.
    Object.assign(new Error("inspect refused by the controller"), { reason: "identity" }),
    inspected("boot-stuck"),
    // The forced stop sets restartedAt; recovery clears it at ready.
    inspected("boot-new", { restartedAt: 1_700_000_000_000 }),
    inspected("boot-new"),
  );
  const healed = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.deepEqual(healed, { ready: true, boot: "boot-new", waitedMs: 15_000, reads: 4 });
});

test("a new boot whose recovery needs a person ends the wait at once, naming the reason", async () => {
  const controller = replies(inspected("boot-new", { needsPerson: "restart_failed" }));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.equal(controller.reads(), 1);
  assert.deepEqual(
    { ready: verdict.ready, boot: verdict.boot, reason: !verdict.ready && verdict.reason },
    { ready: false, boot: "boot-new", reason: "needs a person (restart_failed)" },
  );
});

test("a person needed on the stuck boot does not end the wait: it can be what the release heals", async () => {
  const controller = replies(
    inspected("boot-stuck", { needsPerson: "restart_failed" }),
    inspected("boot-stuck", { needsPerson: "restart_failed" }),
    inspected("boot-new"),
  );
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.deepEqual(verdict, { ready: true, boot: "boot-new", waitedMs: 10_000, reads: 3 });
});

test("the stuck boot is never ready, and the wait is bounded", async () => {
  const controller = replies(inspected("boot-stuck"));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 60_000,
    ...clock(),
  });
  assert.equal(controller.reads(), 13);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.boot, undefined);
  assert.match(!verdict.ready ? verdict.reason : "", /not ready within 60 s/u);
});

test("while the stop waits for in-flight streams the wait says so, and a timeout names the last read", async () => {
  const controller = replies(inspected("boot-stuck", { activeStreams: 3, streamsWaitingSince: 1 }));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 20_000,
    ...clock(),
  });
  assert.ok(!verdict.ready);
  assert.match(verdict.last, /in-flight streams to stand still/u);
  assert.match(verdict.last, /recovery fields: activeStreams, streamsWaitingSince/u);
});

test("a healing release ends healed, serving but needing a person, or not serving", () => {
  const ready = { ready: true as const, boot: "boot-new", waitedMs: 1, reads: 1 };
  const unfinished = (boot?: string) => ({
    ready: false as const,
    ...(boot ? { boot } : {}),
    reason: "needs a person (restart_failed)",
    last: "a new boot, recovery not ready",
    waitedMs: 1,
    reads: 1,
  });
  const served = { passed: true };
  const refused = { passed: false };
  assert.equal(healingOutcome(ready, served), "healed");
  assert.equal(healingOutcome(unfinished("boot-new"), served), "serving-needs-person");
  // Anything else is not serving: a failed model call, or no new boot.
  assert.equal(healingOutcome(ready, refused), "not-serving");
  assert.equal(healingOutcome(unfinished("boot-new"), refused), "not-serving");
  assert.equal(healingOutcome(unfinished(), served), "not-serving");
  assert.equal(healingOutcome(unfinished(), undefined), "not-serving");
  // The pool refused the acceptance device on a new boot: nothing was tested either way.
  const untested = { passed: false, couldNotTest: true };
  assert.equal(healingOutcome(ready, untested), "could-not-test");
  assert.equal(healingOutcome(unfinished("boot-new"), untested), "could-not-test");
  assert.equal(healingOutcome(unfinished(), untested), "not-serving");
});

test("the stop path is read from the forced-stop lines only, as fixed words", () => {
  const answer = JSON.stringify({
    result: {
      events: [
        { message: 'POOL_RUNTIME_FORCED_STOP {"path":"graceful_exit","boot":"boot-stuck"}' },
        { message: 'POOL_RUNTIME_FORCED_STOP {"path":"https://host.example/x"}' },
        { message: 'OTHER_LINE {"path":"destroy_after_grace"}' },
      ],
    },
  });
  assert.deepEqual(stopPaths(answer), ["graceful_exit", "unreadable"]);
});

test("a healing release waits for the object's adoption too when its apply failed", () => {
  // A failed apply may have ended seconds after the upload, before the object ran the new code.
  assert.deepEqual(healingWait("failure"), {
    name: "healingReadinessWithinMs",
    seconds: healingReadinessWithinMs / 1_000,
  });
  // After a successful apply its readiness already waited through the adoption.
  for (const outcome of ["success", undefined])
    assert.deepEqual(healingWait(outcome), {
      name: "healingAcceptanceWithinMs",
      seconds: healingAcceptanceWithinMs / 1_000,
    });
});

test("the pool refusing the acceptance device is could-not-test, never a failed release", async () => {
  // 401 unknown or removed, 403 models off or no longer allowed, 429 a cap or rate limit on its user.
  for (const answer of [{ catalog: 401 }, { catalog: 403 }, { 1: 403 }, { 9: 429 }, { 27: 401 }]) {
    const live = await pool({ answer });
    try {
      const result = await runAcceptance({ credential, expect: "same-boot", client: live.client });
      assert.equal(result.passed, false, JSON.stringify(answer));
      assert.equal(result.couldNotTest, true, JSON.stringify(answer));
      assert.match(result.cause ?? "", /refused for the acceptance device \(HTTP 4\d\d\)/u);
    } finally {
      live.close();
    }
  }
});

test("a serving failure is a failed release even when the pool also refused the device", async () => {
  for (const answer of [{ 5: 503, 9: 429 }, { 3: 500 }, { 4: 502, 6: 401 }]) {
    const live = await pool({ answer });
    try {
      const result = await runAcceptance({ credential, expect: "same-boot", client: live.client });
      assert.equal(result.passed, false, JSON.stringify(answer));
      assert.equal(result.couldNotTest, false, JSON.stringify(answer));
      assert.match(result.cause ?? "", /requests failed: .*HTTP 5\d\d/u);
    } finally {
      live.close();
    }
  }
  // A catalog that does not answer is the pool not serving, as before.
  const down = await pool({ answer: { catalog: 503 } });
  try {
    await assert.rejects(runAcceptance({ credential, expect: "same-boot", client: down.client }));
  } finally {
    down.close();
  }
});

test("a refused device stops the boot read before the apply, even where the pool may not answer", async () => {
  for (const status of [401, 403, 429]) {
    const live = await pool({ answer: { catalog: status } });
    try {
      for (const allowNotServing of [true, false]) {
        const error = await bootBeforeApply(credential, live.client, allowNotServing).then(
          () => assert.fail("a refused device read a boot"),
          (error: unknown) => error,
        );
        assert.ok(error instanceof AcceptanceDeviceRefused, String(error));
        // A cap is not a missing device, so it says what to check instead.
        const check =
          status === 429
            ? "hit its user's cap or a rate limit"
            : "was refused: check that it is still registered and allowed";
        assert.match(
          failureReport(error).publicText,
          new RegExp(`HTTP ${status}.*the release's acceptance device ${check}`, "u"),
        );
      }
    } finally {
      live.close();
    }
  }
  const down = await pool({ answer: { catalog: 503 } });
  try {
    assert.equal(await bootBeforeApply(credential, down.client, true), NOT_SERVING);
    await assert.rejects(bootBeforeApply(credential, down.client, false), /HTTP 503/u);
  } finally {
    down.close();
  }
  const live = await pool();
  try {
    assert.equal(await bootBeforeApply(credential, live.client, false), "boot-root");
  } finally {
    live.close();
  }
});
