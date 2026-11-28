import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// With the pool Worker's own settings, a Request that carries an AbortSignal can't cross an RPC
// call into a Durable Object: the call throws before the object runs, as the PoolOperations
// entrypoint's did after the controller-reset release.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { poolOperationsAnswered, throughController } from "./src/pool/operations-call.ts";
export class Controller extends DurableObject {
  async runtimeHandoff(request) {
    const body = await request.text();
    return new URL(request.url).searchParams.has("refuse")
      ? new Response("refused", { status: 409 })
      : new Response(body);
  }
}
export default {
  async fetch(request, env) {
    const failures = [];
    const answers = [];
    const asked = new URL(request.url).searchParams;
    const signal = asked.has("signal") ? new AbortController().signal : null;
    const passed = new Request("http://pool/runtime-handoff" + (asked.has("refuse") ? "?refuse" : ""), {
      method: "POST",
      body: "answered",
      signal,
    });
    const controller = env.CONTROLLER.get(env.CONTROLLER.idFromName("control"));
    const response = await throughController(
      "/runtime-handoff",
      () => controller.runtimeHandoff(passed),
      (marker, line) => failures.push(marker + " " + line),
      (marker, line) => answers.push(marker + " " + line),
    );
    return Response.json({
      status: response.status,
      body: await response.text(),
      failures,
      answers,
      pool: poolOperationsAnswered(response),
    });
  },
};
`;

async function worker() {
  const bundle = await build({
    stdin: {
      contents: fixture,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
  });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: poolWorkerCompatibility.date,
      compatibilityFlags: poolWorkerCompatibility.flags,
      durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

type Call = { status: number; body: string; failures: string[]; answers: string[]; pool: boolean };

function answeredLine(call: Call) {
  assert.deepEqual(call.failures, []);
  assert.equal(call.answers.length, 1);
  const [marker, fields] = call.answers[0]!.split(" ", 2) as [string, string];
  assert.equal(marker, "POOL_OPERATIONS_ANSWERED");
  const line = JSON.parse(fields) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ["elapsedMs", "route", "status"]);
  assert.equal(line.route, "/runtime-handoff");
  assert.ok(Number.isSafeInteger(line.elapsedMs) && (line.elapsedMs as number) >= 0);
  return line;
}

test(
  "a call into the controller writes one closed line: a failure line and a 500 when it throws, an answered line with the answer's status when the controller answers",
  { timeout: 60_000 },
  async () => {
    const mf = await worker();
    try {
      const failed = (await (await mf.dispatchFetch("http://pool/?signal")).json()) as Call;
      assert.equal(failed.status, 500);
      assert.equal(failed.body, "");
      // The lane tells this 500 from one a proxy on the bridge built only by the pool's mark.
      assert.equal(failed.pool, true);
      assert.deepEqual(failed.answers, []);
      assert.equal(failed.failures.length, 1);
      const [marker, fields] = failed.failures[0]!.split(" ", 2) as [string, string];
      assert.equal(marker, "POOL_OPERATIONS_CALL_FAILED");
      // Closed values only: the platform's message names the AbortSignal, and never appears.
      assert.doesNotMatch(fields, /serialization/u);
      // The message class reads aborted because the platform's text names an AbortSignal; the
      // name says what it was.
      assert.deepEqual(JSON.parse(fields), {
        route: "/runtime-handoff",
        status: 500,
        name: "DataCloneError",
        code: 25,
        messageClass: "aborted",
        isError: true,
        disconnected: null,
        retryable: null,
        overloaded: null,
        remote: null,
        durableObjectReset: null,
      });
      // The same call without the signal reaches the controller, and its answer from the object
      // keeps its body and gains the mark. It writes one closed answered line, and no failure line.
      const answered = (await (await mf.dispatchFetch("http://pool/")).json()) as Call;
      assert.deepEqual(
        { status: answered.status, body: answered.body, pool: answered.pool },
        { status: 200, body: "answered", pool: true },
      );
      assert.equal(answeredLine(answered).status, 200);
      // The controller's own refusal is an answer too, and the line carries its status: these are
      // the lane refusals the line exists to place.
      const refused = (await (await mf.dispatchFetch("http://pool/?refuse")).json()) as Call;
      assert.deepEqual(
        { status: refused.status, body: refused.body, pool: refused.pool },
        { status: 409, body: "refused", pool: true },
      );
      assert.equal(answeredLine(refused).status, 409);
    } finally {
      await mf.dispose();
    }
  },
);
