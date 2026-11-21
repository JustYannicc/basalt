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
import { rewriteCapResponse } from "../../src/pool/cap-message.ts";

// The local pool checks no identity; acceptance-device tests prove what the real pool checks.
const credential = async () => ({ "x-basalt-native-assertion": "fixture" });

// What a model call's client gets for its user's cap: Home's refusal after the pool's own rewrite.
const capBody = await (
  await rewriteCapResponse(
    new Response(
      JSON.stringify({
        error: {
          message:
            "user_period_limit_exceeded: period limit exceeded (window=7d mode=calendar used=12 limit=10)",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    ),
    "/v1/chat/completions",
  )
).text();
// A provider's own 429, which the pool passes through untouched.
const providerBusy = JSON.stringify({
  error: {
    message: "all credentials for model model-a are cooling down",
    type: "rate_limit_error",
  },
});

// A pool endpoint speaking the real wire: /v1/models JSON and a streamed chat completion, each with
// the serving runtime's boot header, as the live pool answers the repo's acceptance client.
async function pool(
  options: {
    fail?: number;
    boots?: string[];
    /**
     * HTTP status per chat number, for every chat, or for the catalog: the pool refusing or failing
     * that call. A 429 is a provider's; "cap" is the pool's cap on the device's user.
     */
    answer?: Partial<Record<number | "chat" | "catalog", number | "cap">>;
  } = {},
) {
  let chats = 0;
  const server = createServer((request, response) => {
    const boot = options.boots?.[chats % options.boots.length] ?? "boot-root";
    const status =
      request.url === "/v1/models"
        ? options.answer?.catalog
        : (options.answer?.[chats + 1] ?? options.answer?.chat);
    if (status !== undefined) {
      if (request.url !== "/v1/models") chats++;
      response.writeHead(status === "cap" ? 429 : status, { "content-type": "application/json" });
      response.end(
        status === "cap"
          ? capBody
          : status === 429
            ? providerBusy
            : JSON.stringify({ error: "unauthorized", message: "refused" }),
      );
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
  // 401 unknown or removed, 403 models off or no longer allowed, or the pool's cap on its user.
  for (const answer of [
    { catalog: 401 },
    { catalog: 403 },
    { 1: 403 },
    { 9: "cap" },
    { 27: 401 },
  ] as const) {
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
  for (const answer of [{ 5: 503, 9: "cap" }, { 3: 500 }, { 4: 502, 6: 401 }] as const) {
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
  for (const status of [401, 403]) {
    const live = await pool({ answer: { catalog: status } });
    try {
      for (const allowNotServing of [true, false]) {
        const error = await bootBeforeApply(credential, live.client, allowNotServing).then(
          () => assert.fail("a refused device read a boot"),
          (error: unknown) => error,
        );
        assert.ok(error instanceof AcceptanceDeviceRefused, String(error));
        assert.match(
          failureReport(error).publicText,
          new RegExp(
            `HTTP ${status}.*the release's acceptance device was refused: check that it is still registered and allowed`,
            "u",
          ),
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

test("after this run's boot read admitted the device, a 401 or 403 is a serving failure", async () => {
  // The boot read before the apply was served for the device, so the release is the likeliest
  // thing that changed: the policy's rollback takes it, as it would a 5xx.
  for (const answer of [{ catalog: 401 }, { catalog: 403 }, { 1: 403 }, { 27: 401 }]) {
    const live = await pool({ answer });
    try {
      const result = await runAcceptance({
        credential,
        expect: "same-boot",
        rootBoot: "boot-root",
        admitted: true,
        client: live.client,
      });
      assert.equal(result.passed, false, JSON.stringify(answer));
      assert.equal(result.couldNotTest, false, JSON.stringify(answer));
      assert.deepEqual(result.refused, [], JSON.stringify(answer));
      assert.equal(result.failures.length, 1, JSON.stringify(answer));
      assert.match(
        result.cause ?? "",
        /HTTP 40[13].*the acceptance device this run's boot read admitted/u,
      );
    } finally {
      live.close();
    }
  }
});

test("a 429 is untested only when it carries the pool's cap code, on a model turn", async () => {
  for (const [answer, admitted] of [
    [{ 9: "cap" }, true],
    [{ chat: "cap" }, true],
    [{ 9: "cap" }, false],
  ] as const) {
    const live = await pool({ answer });
    try {
      const result = await runAcceptance({
        credential,
        expect: "same-boot",
        rootBoot: "boot-root",
        admitted,
        client: live.client,
      });
      assert.equal(result.couldNotTest, true, JSON.stringify(answer));
      assert.deepEqual(result.refused, [429], JSON.stringify(answer));
      assert.match(result.cause ?? "", /refused for the acceptance device \(HTTP 429\)/u);
      assert.equal(result.failures.length, 0, JSON.stringify(answer));
    } finally {
      live.close();
    }
  }
});

test("a provider's 429 on every turn is a serving failure, admitted or not: the release rolls back", async () => {
  // The pool passes a provider's 429 through untouched; only its user's cap is rewritten with a code.
  for (const admitted of [true, false]) {
    const live = await pool({ answer: { chat: 429 } });
    try {
      const result = await runAcceptance({
        credential,
        expect: "same-boot",
        rootBoot: "boot-root",
        admitted,
        client: live.client,
      });
      assert.equal(result.passed, false);
      assert.equal(result.couldNotTest, false, `admitted=${admitted}`);
      assert.deepEqual(result.refused, []);
      assert.equal(result.failures.length, 27);
      assert.match(result.cause ?? "", /^27 of 27 requests failed: .*HTTP 429/u);
    } finally {
      live.close();
    }
  }
});

test("a 429 on /v1/models never carries a cap: the pool is not serving, before the apply or after", async () => {
  const live = await pool({ answer: { catalog: 429 } });
  try {
    for (const admitted of [true, false])
      await assert.rejects(
        runAcceptance({ credential, expect: "same-boot", admitted, client: live.client }),
        /\/v1\/models returned HTTP 429/u,
      );
    // Not a refused device: only a declared root restart may start on a pool answering so.
    assert.equal(await bootBeforeApply(credential, live.client, true), NOT_SERVING);
    await assert.rejects(bootBeforeApply(credential, live.client, false), /HTTP 429/u);
  } finally {
    live.close();
  }
});
