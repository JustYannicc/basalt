import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emulatedAccount } from "./cloudflare.mjs";
import { entryConfig, entryRefusals, publicEntryLines } from "./entry-output.mjs";
import { mockRefusal, mockStarter } from "./mock-start.ts";
import { countingText, fixtures, fixturesFile, fixturesText } from "./fixtures.mjs";
import { LONG_COUNT, longMatch, longPrompt, shortPrompt } from "./prompts.ts";
import { verdict } from "./shapes.mjs";
import {
  application,
  envelope,
  namespace,
  refusalBody,
  script,
} from "../stage-cloudflare/test/cloudflare-shapes.mjs";
import { fakeAccount } from "../stage-cloudflare/test/fake-account.mjs";

/** A container that listens only after `listenAfter` health probes, and can be stopped. */
function fakeContainer({ listenAfter = 3 } = {}) {
  const state = { running: false, starts: 0, probes: 0, forwarded: 0, signals: [] };
  let stop;
  const container = {
    get running() {
      return state.running;
    },
    start() {
      if (state.running) throw new Error("already running");
      state.running = true;
      state.starts++;
      state.probes = 0;
    },
    monitor: () => new Promise((resolve) => (stop = resolve)),
    getTcpPort: () => ({
      async fetch(url, init) {
        if (url !== "http://mock/health") {
          if (state.probes < listenAfter) throw new Error("forwarded before the mock listened");
          state.forwarded++;
          return new Response("ok");
        }
        state.signals.push(init?.signal instanceof AbortSignal);
        state.probes++;
        if (state.probes <= listenAfter) throw new Error("connection refused");
        return new Response("ok");
      },
    }),
  };
  const halt = () => {
    state.running = false;
    stop?.();
  };
  return { container, state, halt };
}
const noWait = () => Promise.resolve();

test("concurrent first requests share one start and none reaches the mock before it listens", async () => {
  const { container, state } = fakeContainer();
  const starter = mockStarter(container, { AIMOCK_API_KEYS: "k" }, noWait);
  const forward = async () => {
    await starter.ready();
    return container.getTcpPort(4010).fetch("http://mock/v1/models");
  };
  const answers = await Promise.all(Array.from({ length: 20 }, forward));
  assert.equal(answers.length, 20);
  assert.equal(state.starts, 1);
  assert.equal(state.forwarded, 20);
  // Every health probe carries its own timeout.
  assert.ok(state.signals.length > 0 && state.signals.every(Boolean));
});

test("once the container stops, the next request starts it again and waits for health", async () => {
  const { container, state, halt } = fakeContainer({ listenAfter: 1 });
  const starter = mockStarter(container, {}, noWait);
  await starter.ready();
  await starter.ready();
  assert.equal(state.starts, 1);
  halt();
  await new Promise((resolve) => setImmediate(resolve));
  await starter.ready();
  assert.equal(state.starts, 2);
  await container.getTcpPort(4010).fetch("http://mock/v1/models");
  assert.equal(state.forwarded, 1);
});

test("a mock that never answers health fails the start, and the next request tries again", async () => {
  const { container, state } = fakeContainer({ listenAfter: Infinity });
  const starter = mockStarter(container, {}, noWait, 5);
  await assert.rejects(starter.ready(), /The mock did not start/u);
  await assert.rejects(starter.ready(), /The mock did not start/u);
  assert.equal(state.probes, 10);
});

test("the mock's own refusal is recognised by its realm", async () => {
  const calls = [];
  const mock = {
    async fetch(_url, init) {
      calls.push(init.headers.authorization ?? "(none)");
      return new Response("{}", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="aimock"' },
      });
    },
  };
  assert.deepEqual(await mockRefusal(mock, "secret"), {
    missing: { status: 401, aimock: true },
    wrong: { status: 401, aimock: true },
  });
  assert.deepEqual(calls, ["(none)", "Bearer secret-wrong"]);
});

// The short streams aimock 1.48.1 sends for the fixture, as captured locally.
const sse = (frames) =>
  frames
    .map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
    .join("");
const chat = (content, { done = true, usage = true } = {}) =>
  sse([
    { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } }] : []),
    ...(done ? ["[DONE]"] : []),
  ]);
const messages = (content, { starts = 1, stop = "end_turn" } = {}) =>
  sse([
    ...Array.from({ length: starts }, () => ({
      type: "message_start",
      message: { usage: { input_tokens: 11, output_tokens: 2 } },
    })),
    { type: "content_block_delta", delta: { type: "text_delta", text: content } },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
const responses = (
  content,
  end = "response.completed",
  usage = { input_tokens: 11, output_tokens: 2 },
) =>
  sse([
    { type: "response.output_text.delta", delta: content },
    { type: end, response: { usage } },
  ]);

test("each shape passes only on the load driver's terminal, usage and exact content", () => {
  assert.equal(verdict("chat", false, chat("OK")).pass, true);
  assert.equal(verdict("chat", false, chat("OK", { done: false })).reason, "no terminal event");
  assert.equal(verdict("chat", false, chat("OK", { usage: false })).reason, "usage missing");
  assert.equal(verdict("chat", false, chat("NO")).reason, "content not exact");
  assert.equal(verdict("messages", false, messages("OK")).pass, true);
  assert.equal(
    verdict("messages", false, messages("OK", { starts: 2 })).reason,
    "no terminal event",
  );
  assert.equal(
    verdict("messages", false, messages("OK", { stop: "stop_sequence" })).reason,
    "no terminal event",
  );
  assert.equal(verdict("responses", false, responses("OK")).pass, true);
  assert.equal(
    verdict("responses", false, responses("OK", "response.incomplete")).reason,
    "no terminal event",
  );
});

test("a long stream passes in every shape only when it counts every line", () => {
  const lost = countingText.replace("\n700\n", "\n");
  for (const [shape, stream] of [
    ["chat", chat],
    ["messages", messages],
    ["responses", responses],
  ]) {
    assert.equal(verdict(shape, true, stream(countingText)).pass, true, shape);
    assert.equal(verdict(shape, true, stream(lost)).reason, "content not exact", shape);
    // A short answer is not a long one.
    assert.equal(verdict(shape, true, stream("OK")).reason, "content not exact", shape);
  }
});

test("usage over the reserve is refused", () => {
  // The short limit is 16 output tokens, the long one 4,000, and input stays within 500.
  assert.equal(
    verdict("responses", false, responses("OK", undefined, { input_tokens: 11, output_tokens: 17 }))
      .reason,
    "usage over the reserve",
  );
  assert.equal(
    verdict(
      "responses",
      true,
      responses(countingText, undefined, { input_tokens: 11, output_tokens: 4001 }),
    ).reason,
    "usage over the reserve",
  );
  assert.equal(
    verdict("responses", false, responses("OK", undefined, { input_tokens: 501, output_tokens: 2 }))
      .reason,
    "usage over the reserve",
  );
});

test("the mock's fixtures answer the check's own prompts, and the committed file is what --write makes", () => {
  assert.equal(readFileSync(fixturesFile, "utf8"), fixturesText());
  const [long, short] = fixtures.fixtures;
  assert.ok(longPrompt.startsWith(long.match.userMessage));
  assert.equal(long.match.userMessage, longMatch);
  assert.equal(short.match.userMessage, shortPrompt);
  assert.equal(long.response.content.split("\n").length, LONG_COUNT);
});

test("only the release entry's own public lines are echoed", () => {
  const stdout = [
    '{"_tag":"Progress","fqn":"Gateway","status":"creating"}',
    '{"_tag":"Progress","message":"https://example.invalid/secret"}',
    "#12 pushing registry.cloudflare.com/acct/basalt-emulated-upstream-mock",
    "Release stopped at apply: StageWriteRefused (refused)",
    "- StageWriteRefused: check=stage field=name",
    "trailing provider text",
    `Applied; a fresh plan is all noop: digest \`${"d".repeat(64)}\`, attempt \`2f0c3a1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b\``,
  ].join("\n");
  const stderr = [
    "Release stopped at apply: StageWriteRefused (refused)",
    "- StageWriteRefused: check=stage field=name",
    "error: Use --stage production, a disposable test-* stage, or scale-<n> for the scale stack",
    "      at deploy.ts:85",
  ].join("\n");
  assert.deepEqual(publicEntryLines(stdout, stderr), [
    '{"_tag":"Progress","fqn":"Gateway","status":"creating"}',
    "Release stopped at apply: StageWriteRefused (refused)",
    "- StageWriteRefused: check=stage field=name",
    `Applied; a fresh plan is all noop: digest \`${"d".repeat(64)}\`, attempt \`2f0c3a1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b\``,
    "error: Use --stage production, a disposable test-* stage, or scale-<n> for the scale stack",
  ]);
});

test("a provider's error line, an id carrying a URL and an account id never reach the log", () => {
  const account = "0123456789abcdef0123456789abcdef";
  const dropped = [
    // Any child process can print `error: `; only the entry's own refusals are its words.
    "error: 403 Forbidden from https://api.cloudflare.com/client/v4/accounts/x/workers/scripts",
    "error: Unknown stack config /home/runner/work/other/stack.ts",
    '{"_tag":"Progress","id":"https://basalt-emulated-upstream-gateway.sub.workers.dev/v1"}',
    '{"_tag":"Progress","id":"basalt-emulated-upstream-gateway.sub.workers.dev"}',
    '{"_tag":"Progress","id":"has space"}',
    `{"_tag":"Progress","id":"${"x".repeat(65)}"}`,
    `{"_tag":"Progress","id":"${account}"}`,
    `Release stopped at apply: refused for ${account}`,
    `error: Unknown stack config ${entryConfig} ${account}`,
  ];
  assert.deepEqual(publicEntryLines(dropped.join("\n"), dropped.join("\n")), []);
  assert.deepEqual(publicEntryLines(`error: Unknown stack config ${entryConfig}`), [
    `error: Unknown stack config ${entryConfig}`,
  ]);
});

test("each refusal the filter keeps is one the entry throws, in its own words", () => {
  const source = ["../release/deploy.ts", "../release/stack-config.ts"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  for (const message of entryRefusals) {
    const text = message.startsWith("Unknown stack config ")
      ? "`Unknown stack config ${value}`"
      : `"${message}"`;
    assert.ok(source.includes(text), message);
  }
});

const prefix = "basalt-emulated-upstream";
/** The account holding the stage's resources beside production's. */
const productionBeside = () =>
  fakeAccount({
    live: {
      applications: [
        application({ id: "a1", name: `${prefix}-mock` }),
        application({ id: "a2", name: "basalt-production-poolcontainer" }),
      ],
      scripts: [script(`${prefix}-gateway`), script("basalt-production-poolworker")],
      namespaces: [
        namespace({ id: "n1", className: "Mock", script: `${prefix}-gateway` }),
        namespace({ id: "n2", className: "Pool", script: "basalt-production-poolworker" }),
      ],
    },
    tags: {
      [`acct/${prefix}-mock`]: ["h1"],
      "acct/basalt-poolcontainer-production": ["p1"],
      [`other/${prefix}-mock`]: ["x1"],
    },
  });
const account = (fetcher) => emulatedAccount({ accountId: "acct", token: "t", prefix, fetcher });

test("the inventory and the destroy touch only what carries the stage's prefix, then prove it gone", async () => {
  const { live, calls, fetcher } = productionBeside();
  const api = account(fetcher);
  const found = await api.inventory();
  assert.deepEqual(
    api.describe(found),
    `container application ${prefix}-mock, Worker ${prefix}-gateway, Durable Object namespace Mock of ${prefix}-gateway, registry repository ${prefix}-mock (1 tags)`,
  );
  await api.destroy();
  const deletes = calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  assert.ok(deletes.length >= 3);
  assert.ok(
    deletes.every((path) => path.includes(prefix) || path.endsWith("/a1")),
    deletes,
  );
  assert.deepEqual(
    live.applications.map((row) => row.name),
    ["basalt-production-poolcontainer"],
  );
  assert.deepEqual(
    live.scripts.map((row) => row.id),
    ["basalt-production-poolworker"],
  );
  assert.deepEqual(live.tags["acct/basalt-poolcontainer-production"], ["p1"]);
  assert.deepEqual(live.tags[`other/${prefix}-mock`], ["x1"]);
  assert.equal(api.empty(await api.inventory()), true);
});

test("a destroy that leaves anything behind names what remains", async () => {
  const { fetcher } = productionBeside();
  // A Worker delete that fails leaves its Worker and namespace in place.
  const failing = (url, init) =>
    init?.method === "DELETE" && url.includes("/workers/scripts/")
      ? Promise.resolve(
          Response.json(refusalBody([{ code: 10013, message: "x" }]), { status: 500 }),
        )
      : fetcher(url, init);
  await assert.rejects(
    account(failing).destroy(),
    new RegExp(
      `remain after teardown: Worker ${prefix}-gateway, Durable Object namespace Mock of ${prefix}-gateway; failed: Worker ${prefix}-gateway: Cloudflare DELETE workers/scripts failed \\(500\\)`,
      "u",
    ),
  );
});

/** The account, with one Cloudflare listing answered by `answer` instead. */
const withListing = (listing, answer) => {
  const { fetcher } = productionBeside();
  return (url, init) =>
    new URL(url).pathname.endsWith(`/acct/${listing}`)
      ? Promise.resolve(answer())
      : fetcher(url, init);
};

test("a refused, failed or unrecognised listing stops the inventory instead of reading as empty", async () => {
  const answer =
    (body, status = 200) =>
    () =>
      Response.json(body, { status });
  for (const [label, respond, message] of [
    ["a 404", answer({}, 404), /Cloudflare GET workers\/scripts failed \(404\)/u],
    [
      "a 403",
      answer(refusalBody([{ code: 10000, message: "secret text" }]), 403),
      /Cloudflare GET workers\/scripts failed \(403\)/u,
    ],
    ["success false", answer(refusalBody([])), /Cloudflare GET workers\/scripts failed \(200\)/u],
    ["no array", answer(envelope({})), /Unrecognized Cloudflare list response/u],
    [
      "no JSON",
      () => new Response("<html>x</html>"),
      /Cloudflare GET workers\/scripts failed \(200\)/u,
    ],
  ]) {
    const api = account(withListing("workers/scripts", respond));
    await assert.rejects(api.inventory(), (error) => {
      assert.match(error.message, message, label);
      assert.doesNotMatch(error.message, /secret text|html/u, label);
      return true;
    });
    // A destroy proves absence only from an inventory that answered.
    await assert.rejects(api.destroy(), message, label);
  }
});

test("a missing Worker reads as no lease; any other refusal of its settings throws", async () => {
  const { fetcher } = fakeAccount();
  assert.equal(await account(fetcher).lease(`${prefix}-gateway`), undefined);
  const leased = fakeAccount({
    live: { scripts: [script(`${prefix}-gateway`)] },
    bindings: { [`${prefix}-gateway`]: { DELETE_BY: "1767225600000" } },
  });
  assert.equal(await account(leased.fetcher).lease(`${prefix}-gateway`), 1767225600000);
  const refused = (url, init) =>
    url.includes("/settings")
      ? Promise.resolve(Response.json({}, { status: 403 }))
      : fetcher(url, init);
  await assert.rejects(
    account(refused).lease(`${prefix}-gateway`),
    /Cloudflare GET workers\/scripts failed \(403\)/u,
  );
  // The lease is read only from the stage's own Worker.
  await assert.rejects(account(fetcher).lease("basalt-production-poolworker"), /^Error: Refused/u);
});
