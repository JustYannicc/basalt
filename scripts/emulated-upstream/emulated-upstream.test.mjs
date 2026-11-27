import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emulatedAccount } from "./cloudflare.mjs";
import {
  entryConfig,
  entryRefusals,
  progressTags,
  publicEntryLines,
  releaseCause,
} from "./entry-output.mjs";
import { mockRefusal, mockStarter } from "./mock-start.ts";
import { countingText, fixtures, fixturesFile, fixturesText } from "./fixtures.mjs";
import { LONG_COUNT, longMatch, longPrompt, shortPrompt } from "./prompts.ts";
import { paths, requestBody, verdict } from "./shapes.mjs";
import { emulatedStage } from "./stage.mjs";
import { chaos429Body, streamOf, wholeOf } from "./test/aimock-shapes.mjs";
import {
  application,
  envelope,
  namespace,
  refusalBody,
  script,
} from "../stage-cloudflare/test/cloudflare-shapes.mjs";
import { IMAGE_TYPES, KEPT_TYPES } from "../stage-cloudflare/kept-entries.mjs";
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

test("the bodies the load driver sends stream as before; stream: false drops only the stream's options", () => {
  const model = "emulated-check";
  const short = [{ role: "user", content: shortPrompt }];
  const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  same(requestBody("chat", false), {
    model,
    max_tokens: 16,
    stream: true,
    stream_options: { include_usage: true },
    messages: short,
  });
  same(requestBody("responses", true), {
    model,
    max_output_tokens: 4000,
    stream: true,
    input: longPrompt,
  });
  same(requestBody("messages", false), { model, max_tokens: 16, stream: true, messages: short });
  for (const shape of Object.keys(paths))
    same(requestBody(shape, false, { stream: true }), requestBody(shape, false));
  same(requestBody("chat", false, { stream: false }), {
    model,
    max_tokens: 16,
    stream: false,
    messages: short,
  });
  same(requestBody("responses", false, { stream: false }), {
    model,
    max_output_tokens: 16,
    stream: false,
    input: shortPrompt,
  });
  same(requestBody("messages", true, { stream: false }), {
    model,
    max_tokens: 4000,
    stream: false,
    messages: [{ role: "user", content: longPrompt }],
  });
});

test("aimock's recorded streams still pass the stream rule, with or without the option", () => {
  for (const shape of Object.keys(paths)) {
    const stream = streamOf(shape, "OK");
    assert.deepEqual(verdict(shape, false, stream), {
      pass: true,
      reason: undefined,
      input: 11,
      output: 2,
    });
    assert.deepEqual(
      verdict(shape, false, stream, { stream: true }),
      verdict(shape, false, stream),
    );
    assert.equal(verdict(shape, false, streamOf(shape, "NO")).reason, "content not exact", shape);
  }
});

test("a call with stream: false passes only on its one answer's end, usage and exact content", () => {
  const whole = (shape, long, text) => verdict(shape, long, text, { stream: false });
  const edited = (shape, change) => {
    const body = JSON.parse(wholeOf(shape, "OK"));
    change(body);
    return JSON.stringify(body);
  };
  for (const shape of Object.keys(paths)) {
    assert.deepEqual(whole(shape, false, wholeOf(shape, "OK")), {
      pass: true,
      reason: undefined,
      input: 11,
      output: 2,
    });
    assert.equal(whole(shape, false, wholeOf(shape, "NO")).reason, "content not exact", shape);
    assert.equal(whole(shape, false, wholeOf(shape, " OK\n")).pass, true, shape);
    assert.equal(
      whole(shape, false, wholeOf(shape, "OK", { output: 17 })).reason,
      "usage over the reserve",
      shape,
    );
    assert.equal(
      whole(shape, true, wholeOf(shape, countingText, { input: 22, output: 3000 })).pass,
      true,
      shape,
    );
    assert.equal(whole(shape, true, wholeOf(shape, "OK")).reason, "content not exact", shape);
    assert.equal(
      whole(
        shape,
        false,
        edited(shape, (body) => delete body.usage),
      ).reason,
      "usage missing",
      shape,
    );
    // aimock's chaos 429 is no answer, a stream is not a whole answer, and the reverse.
    assert.equal(whole(shape, false, chaos429Body).reason, "no terminal event", shape);
    assert.equal(whole(shape, false, streamOf(shape, "OK")).reason, "not a JSON answer", shape);
    assert.equal(whole(shape, false, "").reason, "not a JSON answer", shape);
    assert.equal(verdict(shape, false, wholeOf(shape, "OK")).reason, "no terminal event", shape);
  }
  // Each shape's own unfinished end is not an answer.
  for (const [shape, change] of [
    ["chat", (body) => (body.choices[0].finish_reason = "length")],
    ["chat", (body) => (body.object = "chat.completion.chunk")],
    ["responses", (body) => (body.status = "incomplete")],
    ["messages", (body) => (body.stop_reason = "stop_sequence")],
    ["messages", (body) => (body.type = "error")],
  ])
    assert.equal(whole(shape, false, edited(shape, change)).reason, "no terminal event", shape);
  // An error beside a finished answer still fails it.
  assert.equal(
    whole(
      "chat",
      false,
      edited("chat", (body) => (body.error = { type: "server_error" })),
    ).reason,
    "error event",
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
const account = (fetcher, options = {}) =>
  emulatedAccount({ accountId: "acct", token: "t", prefix, fetcher, wait: noWait, ...options });

test("the inventory and the destroy touch only what carries the stage's prefix, then prove it gone", async () => {
  const { live, calls, fetcher } = productionBeside();
  const api = account(fetcher);
  const found = await api.inventory();
  assert.deepEqual(
    api.describe(found),
    `container application ${prefix}-mock, Worker ${prefix}-gateway, Durable Object namespace Mock of ${prefix}-gateway, registry repository ${prefix}-mock (1 tags, 0 digest entries)`,
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
      : leased.fetcher(url, init);
  await assert.rejects(
    account(refused).lease(`${prefix}-gateway`),
    /Cloudflare GET workers\/scripts failed \(403\)/u,
  );
  // The lease is read only from the stage's own Worker.
  await assert.rejects(account(fetcher).lease("basalt-production-poolworker"), /^Error: Refused/u);
});

test("a frame a provider's SDK treats as an error fails the verdict in every shape", () => {
  for (const shape of ["chat", "messages", "responses"]) {
    const clean = streamOf(shape, "OK");
    assert.equal(verdict(shape, false, clean).pass, true, shape);
    // Each is inserted before the stream's first frame, so the rest of the answer stays clean.
    const before = (line) => `${line}\n\n${clean}`;
    for (const [what, line] of [
      ["error frame without the optional space", `data:${chaos429Body}`],
      ["frame that is not JSON", "data: {not json"],
      ["null frame", "data: null"],
      ["array frame", "data: []"],
    ])
      assert.equal(verdict(shape, false, before(line)).reason, "error event", `${shape}: ${what}`);
  }
});

test("an answer whose content is not text fails instead of throwing", () => {
  const answer = JSON.parse(wholeOf("chat", "OK"));
  answer.choices[0].message.content = { text: "OK" };
  assert.equal(
    verdict("chat", false, JSON.stringify(answer), { stream: false }).reason,
    "content not exact",
  );
});

test("a failed entry names its cause from a closed set, and never its message", () => {
  const account = "0123456789abcdef0123456789abcdef";
  const host = "basalt-emulated-upstream-gateway.example-subdomain.workers.dev";
  const leak = `${account} ${host} https://${host}/v1 /accounts/${account}/workers/scripts/x`;
  const cases = [
    [
      "Release stopped in deploy: Error (failed): Error: State store version 5, expected 8: upgrade it deliberately first",
      "release cause: state_store_version store=5 expected=8",
    ],
    [
      `Release stopped in deploy at Mock (Worker): WireRefused (refused): WireRefused: wire guard refused PUT /accounts/${account}/workers/scripts/x (Worker): migrations.deleted_classes = ["Mock"]. ${leak} Fix: none`,
      "release cause: wire_refused field=migrations.deleted_classes",
    ],
    [
      `Release stopped in plan: Unauthorized (failed): Unauthorized: Authentication failed (status: 400) ${leak}`,
      "release cause: unauthorized",
    ],
    [
      `Release stopped in deploy at Gateway (Worker): TypeError (failed): TypeError: fetch to ${host} failed for ${account}`,
      "release cause: unclassified class=TypeError step=deploy",
    ],
    [`something else entirely: ${leak}`, "release cause: unclassified class=unknown step=unknown"],
    [
      `Release stopped in ${host}: ${account} (failed): ${leak}`,
      "release cause: unclassified class=unknown step=unknown",
    ],
    ["", "release cause: no_detail"],
    [undefined, "release cause: no_detail"],
  ];
  for (const [detail, line] of cases) {
    const cause = releaseCause(detail);
    assert.equal(cause, line);
    assert.doesNotMatch(cause, /[0-9a-f]{32}|workers\.dev|example|https?:|\/accounts\//u, line);
  }
  // A field that could hold anything but a plain name is not printed as one.
  assert.equal(
    releaseCause(
      `Release stopped in deploy: WireRefused (refused): wire guard refused PUT /x (Worker): ${host}/a = 1. why`,
    ),
    "release cause: unclassified class=WireRefused step=deploy",
  );
});

test("a cause line never carries an id, a host or a field outside the wire guard's own words", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  for (const [detail, line] of [
    // An unknown migration key that is an id, and an error tag that is one.
    [
      `Release stopped in deploy: WireRefused (refused): wire guard refused PUT /x (Worker): migrations.${hex} = 1. why`,
      "release cause: unclassified class=WireRefused step=deploy",
    ],
    [
      `Release stopped in deploy: ${hex} (failed): x`,
      "release cause: unclassified class=unknown step=deploy",
    ],
    // A resource text that imitates the refusal's own shape.
    [
      "Release stopped in deploy: WireRefused (refused): wire guard refused PUT /x (W): secret-host.example.com = 1). y",
      "release cause: unclassified class=WireRefused step=deploy",
    ],
    [
      "Release stopped in deploy: WireRefused (refused): wire guard refused PUT /x (Worker): exports.Mock.state = deleted. y",
      "release cause: wire_refused field=exports.Mock.state",
    ],
  ])
    assert.equal(releaseCause(detail), line);
});

test("a progress event shows only with one of the framework's own tags, never a host-shaped one", () => {
  const event = (tag, extra = {}) => JSON.stringify({ _tag: tag, status: "created", ...extra });
  const shown = [...progressTags].map((tag) => event(tag, { fqn: "Gateway" }));
  assert.deepEqual(publicEntryLines(shown.join("\n")), shown);
  assert.equal(progressTags.length, 18);
  const dropped = [
    "api.cloudflare.com",
    "basalt-emulated-upstream-gateway.example.workers.dev",
    "plan.phases",
    "plan.phas",
    "Plan.phase",
    "plan.phase ",
    " plan.phase",
    "plan..phase",
    "apply.resource.statuz",
  ].map((tag) => event(tag));
  // A listed tag is a tag only under `_tag`: any other field keeps the dot-free rule.
  dropped.push(JSON.stringify({ _tag: "plan.phase", fqn: "plan.phase" }));
  assert.deepEqual(publicEntryLines(dropped.join("\n")), []);
});

test("an event prints as what was checked, so a duplicate key, an escape or padding carries nothing", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  const lines = publicEntryLines(
    [
      // The parsed object keeps the last `_tag`; the host in the first is never printed.
      '{"_tag":"api.cloudflare.com","_tag":"plan.phase","phase":"planning"}',
      // An id written with one escaped character is the id once parsed, and the id check sees it.
      `{"_tag":"plan.phase","id":"\\u0030${hex.slice(1)}"}`,
      '{ "_tag" : "plan.phase" ,  "phase" : "planning" }',
      '{"fqn":"https://host.example/x","fqn":"Gateway","_tag":"apply.resource.status"}',
    ].join("\n"),
  );
  assert.deepEqual(lines, [
    '{"_tag":"plan.phase","phase":"planning"}',
    '{"_tag":"plan.phase","phase":"planning"}',
    '{"fqn":"Gateway","_tag":"apply.resource.status"}',
  ]);
  for (const line of lines) assert.doesNotMatch(line, /cloudflare|example|https?:|[0-9a-f]{32}/u);
  // The list is frozen and the set that decides is private: adding to the list changes nothing.
  assert.throws(() => progressTags.push("api.cloudflare.com"));
  assert.deepEqual(publicEntryLines('{"_tag":"api.cloudflare.com"}'), []);
});

test("a destroy of a deployed stage whose image has a long tag list ends with nothing left", async () => {
  const { live, fetcher } = fakeAccount({
    live: {
      applications: [application({ id: "a1", name: `${prefix}-mock` })],
      scripts: [script(`${prefix}-gateway`)],
      namespaces: [namespace({ id: "n1", className: "Mock", script: `${prefix}-gateway` })],
    },
    tags: { [`acct/${prefix}-mock`]: ["h1", "h2", "cache.v1", "h3", "h4"] },
    tagPageSize: 2,
  });
  const lines = [];
  await emulatedStage({
    api: account(fetcher),
    key: "k".repeat(43),
    fetcher,
    summary: (line) => lines.push(line),
    save: () => {},
    deployEntry: () => {},
  }).destroy();
  assert.equal(live.applications.length, 0);
  assert.equal(live.scripts.length, 0);
  assert.equal(live.namespaces.length, 0);
  assert.ok(
    lines.includes(
      `- after teardown: no container application, Worker, Durable Object namespace or tagged image named ${prefix}-*`,
    ),
    lines.join("\n"),
  );
});

const imageManifest = () => ({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.image.config.v1+json" },
});
const indexBody = () => ({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [],
});

// The registry as run 46020606930 read it: five entries a page whatever `n` asks, a next link of
// the page's last entry, digest entries first, then the tags.
const chainType = "application/vnd.cloudchamber.btrfs-chain.v1";
const chain = `sha256:${"c".repeat(64)}`;
// The fake account's own image: its index, and the platform manifest the index names.
const ownIndex = `sha256:${"a".repeat(64)}`;
const ownPlatform = `sha256:${"b".repeat(64)}`;
const singleton = { status: 409, code: "SINGLETON_ARTIFACT_EXISTS" };
const cloudflareStage = (cloudflare, tags = ["h1", "h2", "cache.v1", "h3", "h4", "h5", "h6"]) =>
  fakeAccount({
    live: {
      applications: [application({ id: "a1", name: `${prefix}-mock` })],
      scripts: [script(`${prefix}-gateway`)],
      namespaces: [namespace({ id: "n1", className: "Mock", script: `${prefix}-gateway` })],
    },
    tags: { [`acct/${prefix}-mock`]: tags },
    cloudflare: { pageSize: 5, ...cloudflare },
  });
const destroyOn = async (fake) => {
  const lines = [];
  const saved = {};
  await emulatedStage({
    api: account(fake.fetcher),
    key: "k".repeat(43),
    fetcher: fake.fetcher,
    summary: (line) => lines.push(line),
    save: (name, value) => (saved[name] = value),
    deployEntry: () => {},
  }).destroy();
  return { lines, saved };
};
const nothingLeft = `- after teardown: no container application, Worker, Durable Object namespace or tagged image named ${prefix}-*`;

test("a destroy reads the registry's list of digest entries and tags, however it ends, and leaves nothing", async () => {
  for (const shape of [
    { emptyEnd: true },
    { emptyEnd: false },
    { emptyEnd: true, order: "lexical" },
    { emptyEnd: false, order: "lexical" },
    // The form recorded for this registry: the full request URL, no brackets, a second query.
    { emptyEnd: true, linkForm: "recorded" },
    { emptyEnd: false, linkForm: "recorded", order: "lexical" },
    // A form nobody has seen: the spec's own `last` reads the list all the same.
    { emptyEnd: false, linkForm: "unknown" },
    { emptyEnd: true, linkForm: "unknown", order: "lexical" },
  ]) {
    const fake = cloudflareStage(shape);
    const { lines, saved } = await destroyOn(fake);
    assert.ok(lines.includes(nothingLeft), `${JSON.stringify(shape)}\n${lines.join("\n")}`);
    assert.equal(fake.live.manifests[`acct/${prefix}-mock`].size, 0);
    assert.deepEqual(fake.live.tags[`acct/${prefix}-mock`], []);
    assert.deepEqual(saved.teardown.kept, []);
  }
});

test("the registry's own artifact, refused as the registry keeps it, is reported kept, and a deploy is not refused", async () => {
  for (const [refuse, refused] of [
    [singleton, "409 SINGLETON_ARTIFACT_EXISTS"],
    [{ status: 403 }, "403"],
  ]) {
    const fake = cloudflareStage({
      emptyEnd: true,
      // Served only to a read that accepts its own type, as a registry may.
      artifacts: [{ digest: chain, type: chainType, refuse, acceptOnly: chainType }],
    });
    const { lines, saved } = await destroyOn(fake);
    assert.ok(!lines.includes(nothingLeft), lines.join("\n"));
    assert.ok(
      lines.includes(
        `- after teardown: no container application, Worker, Durable Object namespace or tag named ${prefix}-* remains; 1 entry is kept by the registry: 1 × ${chainType}, delete refused ${refused}`,
      ),
      lines.join("\n"),
    );
    assert.deepEqual(saved.teardown.kept, [{ type: chainType, class: refused }]);
    // The deploy's guard reads the repository again and finds only what the registry keeps.
    const found = await account(fake.fetcher).inventory();
    assert.equal(account(fake.fetcher).empty(found), true);
    assert.deepEqual(
      found.kept.map((row) => row.types),
      [[chainType]],
    );
  }
});

test("anything else the registry refuses fails the destroy closed, with a record of closed facts", async () => {
  const cases = {
    "a kept type refused with another status": {
      artifacts: [{ digest: chain, type: chainType, refuse: { status: 500 } }],
    },
    "a type not on the list": {
      artifacts: [{ digest: chain, type: "application/vnd.example.thing", refuse: singleton }],
    },
    "a manifest that cannot be read": {
      artifacts: [{ digest: chain, type: chainType, refuse: singleton, read: 500 }],
    },
    "the stage's own platform manifest": { refuse: { [ownPlatform]: { status: 403 } } },
    "the stage's own index, refused as an artifact would be": { refuse: { [ownIndex]: singleton } },
    // An untagged entry that is an image, whatever it names, is never the registry's.
    "an untagged image manifest refused 403": {
      artifacts: [{ digest: chain, body: imageManifest(), refuse: { status: 403 } }],
    },
    "an untagged index refused as an artifact would be": {
      artifacts: [{ digest: chain, body: indexBody(), refuse: singleton }],
    },
    "an index naming the registry's artifact type, refused 403": {
      artifacts: [
        {
          digest: chain,
          body: { ...indexBody(), artifactType: chainType },
          refuse: { status: 403 },
        },
      ],
    },
    "an image manifest naming the registry's artifact type, refused 403": {
      artifacts: [
        {
          digest: chain,
          body: { ...imageManifest(), artifactType: chainType },
          refuse: { status: 403 },
        },
      ],
    },
    // OCI makes a manifest's own media type optional: the body still says what it is.
    "an image manifest without its media type, naming the chain type, refused 403": {
      artifacts: [
        {
          digest: chain,
          body: {
            schemaVersion: 2,
            artifactType: chainType,
            config: imageManifest().config,
            layers: [],
          },
          refuse: { status: 403 },
        },
      ],
    },
    "an index without its media type, naming the chain type, refused 403": {
      artifacts: [
        {
          digest: chain,
          body: { schemaVersion: 2, artifactType: chainType, manifests: [] },
          refuse: { status: 403 },
        },
      ],
    },
    "an OCI manifest with no config, naming the chain type, refused 403": {
      artifacts: [
        {
          digest: chain,
          body: { schemaVersion: 2, mediaType: imageManifest().mediaType, artifactType: chainType },
          refuse: { status: 403 },
        },
      ],
    },
    "a kept-type delete accepted yet still listed": {
      artifacts: [{ digest: chain, type: chainType, refuse: { stays: true } }],
    },
    "a kept type refused 409 without the registry's code": {
      artifacts: [{ digest: chain, type: chainType, refuse: { status: 409 } }],
    },
    "a kept type refused 500 with the registry's code": {
      artifacts: [
        { digest: chain, type: chainType, refuse: { status: 500, code: singleton.code } },
      ],
    },
    "a kept artifact beside a refused image": {
      artifacts: [{ digest: chain, type: chainType, refuse: singleton }],
      refuse: { [ownPlatform]: { status: 403 } },
    },
  };
  for (const [name, cloudflare] of Object.entries(cases)) {
    const fake = cloudflareStage({ emptyEnd: true, ...cloudflare });
    const error = await destroyOn(fake).then(
      () => assert.fail(`${name}: the destroy succeeded`),
      (caught) => caught,
    );
    assert.match(error.message, /^Emulated upstream resources remain after teardown: /u, name);
    if (name === "the stage's own platform manifest")
      assert.match(error.message, /\(0 tags, 1 digest entries\)/u, name);
    if (name === "a kept-type delete accepted yet still listed") {
      // Nothing was refused, so nothing is proven kept: the read after is what fails it.
      assert.match(error.message, /not proven kept in this run/u, name);
      continue;
    }
    const [deletes] = error.record.teardown;
    assert.ok(deletes.registryDeletes.refused.length > 0, name);
    for (const refused of deletes.registryDeletes.refused) {
      assert.ok([...KEPT_TYPES, ...IMAGE_TYPES, "unread", "other"].includes(refused.type), name);
      assert.doesNotMatch(JSON.stringify(refused), /sha256|example|acct/u, name);
    }
    // An entry beside a refused image is never the registry's: no tag may be left by then.
    if (name === "a kept artifact beside a refused image")
      assert.deepEqual(deletes.registryDeletes.kept, [], name);
  }
});

test("an artifact whose delete could not be sent is never kept, though a read finds only its type", async () => {
  const fake = cloudflareStage({
    emptyEnd: true,
    artifacts: [{ digest: chain, type: chainType, refuse: { throws: true } }],
  });
  await assert.rejects(
    destroyOn(fake),
    /^Error: Emulated upstream resources remain after teardown: .*not proven kept in this run/u,
  );
});

test("an entry refused, then collected by the registry before the read after, is not reported kept", async () => {
  const fake = cloudflareStage({
    emptyEnd: true,
    artifacts: [{ digest: chain, type: chainType, refuse: { ...singleton, removes: true } }],
  });
  const { lines, saved } = await destroyOn(fake);
  assert.ok(lines.includes(nothingLeft), lines.join("\n"));
  assert.deepEqual(saved.teardown.kept, []);
});

test("kept is proven entry by entry, not by count", async () => {
  const second = `sha256:${"e".repeat(64)}`;
  // One refused then collected, the other accepted yet still listed: one refusal, one entry left,
  // and the entry left is not the one refused.
  const swapped = cloudflareStage({
    emptyEnd: true,
    artifacts: [
      { digest: chain, type: chainType, refuse: { ...singleton, removes: true } },
      { digest: second, type: chainType, refuse: { stays: true } },
    ],
  });
  const error = await destroyOn(swapped).then(
    () => assert.fail("the destroy succeeded"),
    (caught) => caught,
  );
  assert.match(error.message, /not proven kept in this run/u);
  assert.deepEqual(error.record.teardown, [
    { unproven: { entries: 1, proven: 0, types: [chainType] } },
  ]);
  // Two refused, one of them collected: the one still there is kept, and only it is said.
  const collected = cloudflareStage({
    emptyEnd: true,
    artifacts: [
      { digest: chain, type: chainType, refuse: { ...singleton, removes: true } },
      { digest: second, type: chainType, refuse: singleton },
    ],
  });
  const { lines, saved } = await destroyOn(collected);
  assert.ok(
    lines.some((line) =>
      line.endsWith(
        `1 entry is kept by the registry: 1 × ${chainType}, delete refused 409 SINGLETON_ARTIFACT_EXISTS`,
      ),
    ),
    lines.join("\n"),
  );
  assert.deepEqual(saved.teardown.kept, [
    { type: chainType, class: "409 SINGLETON_ARTIFACT_EXISTS" },
  ]);
  for (const line of lines) assert.doesNotMatch(line, /sha256/u, line);
});

test("two tags naming one refused index send one delete and count one refusal", async () => {
  const fake = cloudflareStage({ emptyEnd: true, refuse: { [ownIndex]: { status: 403 } } }, [
    "h1",
    "h2",
  ]);
  const error = await destroyOn(fake).then(
    () => assert.fail("the destroy succeeded"),
    (caught) => caught,
  );
  const [deletes] = error.record.teardown;
  assert.equal(deletes.registryDeletes.refused.length, 1);
  assert.equal(
    fake.calls.filter(
      (call) => call.method === "DELETE" && call.url.endsWith(`/manifests/${ownIndex}`),
    ).length,
    1,
  );
});

test("a repository the registry keeps is tried again by the next teardown, and still said", async () => {
  const fake = cloudflareStage({
    emptyEnd: true,
    artifacts: [{ digest: chain, type: chainType, refuse: singleton }],
  });
  const kept = `1 entry is kept by the registry: 1 × ${chainType}, delete refused 409 SINGLETON_ARTIFACT_EXISTS`;
  for (const run of [1, 2]) {
    const { lines } = await destroyOn(fake);
    assert.ok(
      lines.some((line) => line.endsWith(kept)),
      `${run}: ${lines.join("\n")}`,
    );
  }
  const deletes = fake.calls.filter(
    (call) => call.method === "DELETE" && call.url.endsWith(`/manifests/${chain}`),
  );
  assert.equal(deletes.length, 2);
});

test("the deploy's guard ignores a repository only when every entry is the registry's", async () => {
  const other = `sha256:${"d".repeat(64)}`;
  const repositories = {
    "only the registry's artifact": [
      { own: false, artifacts: [{ digest: chain, type: chainType }] },
      [],
      false,
    ],
    "an image's tag beside the registry's artifact": [
      { artifacts: [{ digest: chain, type: chainType }] },
      ["h1"],
      true,
    ],
    // The list names the tag, and its read by that tag answers 404 to the same credential.
    "a listed tag with no manifest behind it, beside the registry's artifact": [
      { own: false, artifacts: [{ digest: chain, type: chainType }] },
      ["h1"],
      false,
    ],
    "a listed tag whose read fails another way, beside the registry's artifact": [
      {
        own: false,
        tagged: { h1: other },
        artifacts: [
          { digest: chain, type: chainType },
          { digest: other, body: imageManifest(), read: 503 },
        ],
      },
      ["h1"],
      true,
    ],
    "a tag naming the registry's artifact": [
      { own: false, tagged: { h1: chain }, artifacts: [{ digest: chain, type: chainType }] },
      ["h1"],
      true,
    ],
    "an image manifest beside the registry's artifact": [
      {
        own: false,
        artifacts: [
          { digest: chain, type: chainType },
          { digest: other, body: imageManifest() },
        ],
      },
      [],
      true,
    ],
    "a type not on the list": [
      { own: false, artifacts: [{ digest: chain, type: "application/vnd.example.thing" }] },
      [],
      true,
    ],
    "an unreadable manifest": [
      { own: false, artifacts: [{ digest: chain, type: chainType, read: 500 }] },
      [],
      true,
    ],
  };
  for (const [name, [cloudflare, tags, refused]] of Object.entries(repositories)) {
    const fake = cloudflareStage({ emptyEnd: true, ...cloudflare }, tags);
    fake.live.applications.length = 0;
    fake.live.scripts.length = 0;
    fake.live.namespaces.length = 0;
    const error = await emulatedStage({
      api: account(fake.fetcher),
      key: "k".repeat(43),
      fetcher: fake.fetcher,
      summary: () => {},
      save: () => {},
      // The guard is all this test reads: past it, the deploy stops here.
      deployEntry: () => {
        throw new Error("past the guard");
      },
    })
      .deploy()
      .then(
        () => undefined,
        (caught) => caught,
      );
    assert.equal(
      /already exists/u.test(error?.message ?? ""),
      refused,
      `${name}: ${error?.message}`,
    );
    if (!refused) assert.equal(error?.message, "past the guard", name);
  }
});

// The registry as a destroy on 27-11 left it: two tags and three digest entries its list names, and
// no manifest behind any of them.
const ghosts = ["e", "f", "9"].map((hex) => `sha256:${hex.repeat(64)}`);
const listedOnly = (extra = {}) =>
  cloudflareStage({ emptyEnd: true, own: false, ghosts, ...extra }, ["h1", "h2"]);
const control =
  "the repository's tag list, answered to the run's one registry credential, named each entry";
const registryCalls = (fake, method) =>
  fake.calls.filter((call) => call.host === "registry.cloudflare.com" && call.method === method);

test("entries the list names with no manifest behind them end the destroy green, counted, and pass the deploy's guard", async () => {
  const fake = listedOnly();
  const { lines, saved } = await destroyOn(fake);
  assert.ok(lines.includes(nothingLeft), lines.join("\n"));
  assert.ok(
    lines.includes(
      "- listed without a manifest: 2 tags and 3 digest entries the registry's list still names, each read 404 by its own reference to the credential that list answered to",
    ),
    lines.join("\n"),
  );
  const facts = { tags: 2, digests: 3, read: { ok: 0, absent: 5, other: 0 }, control };
  assert.deepEqual(saved.teardown.listedWithoutManifest, [facts]);
  assert.deepEqual(saved.teardown.record.reads.at(-1).repositories, [{ ...facts, placed: "gone" }]);
  // Nothing stands behind the list, so no registry delete is sent.
  assert.equal(registryCalls(fake, "DELETE").length, 0);
  // The deploy's guard reads every entry again in its own run and sets the repository apart the
  // same way; it reads no record of an earlier run.
  const api = account(fake.fetcher);
  const found = await api.inventory();
  assert.equal(api.empty(found), true);
  assert.deepEqual(found.facts, [{ ...facts, placed: "gone" }]);
  for (const line of [...lines, JSON.stringify(saved)])
    assert.doesNotMatch(line, /sha256|acct\/|h1|h2/u, line);
});

test("every registry request of a run goes to its one credential, so the list is its reads' control", async () => {
  const fake = listedOnly();
  await destroyOn(fake);
  const sent = fake.calls.filter((call) => call.host === "registry.cloudflare.com");
  assert.ok(sent.length > 5, String(sent.length));
  assert.equal(new Set(sent.map((call) => call.authorization)).size, 1);
  assert.ok(sent[0].authorization);
  const minted = fake.calls.filter((call) => call.path.endsWith("/credentials"));
  assert.equal(minted.length, 1);
  assert.deepEqual(JSON.parse(minted[0].body).permissions, ["pull", "push"]);
});

test("a read by reference that fails another way is never absence: the destroy fails closed with its record", async () => {
  for (const status of [500, 503]) {
    const fake = listedOnly({
      ghosts: [],
      tagged: { h1: chain, h2: chain },
      // Accepted, yet still listed, and its reads fail: it may be there.
      artifacts: [{ digest: chain, body: imageManifest(), read: status, refuse: { stays: true } }],
    });
    const waits = [];
    const error = await account(fake.fetcher, { wait: async (ms) => void waits.push(ms) })
      .destroy()
      .then(
        () => assert.fail("the destroy succeeded"),
        (caught) => caught,
      );
    assert.match(
      error.message,
      /^Emulated upstream resources remain after teardown: registry repository /u,
    );
    // The tag's read failed in the delete pass too, so that pass failed and no read is retried.
    assert.equal(error.record.failedDeletes, 1, String(status));
    assert.equal(error.record.reads.length, 1, String(status));
    assert.deepEqual(waits, []);
    assert.deepEqual(error.record.reads.at(-1).repositories[0].read, {
      ok: 0,
      absent: 0,
      other: 3,
    });
    assert.equal(error.record.readBackCut, false);
  }
});

test("deletes the registry accepts and collects a little later: the read-back waits for them and ends green", async () => {
  const fake = cloudflareStage({ emptyEnd: true, collectAfter: 3 });
  const waits = [];
  const { record } = await account(fake.fetcher, {
    wait: async (ms) => void waits.push(ms),
  }).destroy();
  // Each read-back reads the list's first page twice, so the third such page is the second read.
  assert.equal(record.reads.length, 2);
  assert.deepEqual(waits, [20_000]);
  assert.deepEqual(record.registryDeletes[0].delete, { accepted: 2, absent: 0, refused: 0 });
  assert.equal(fake.live.manifests[`acct/${prefix}-mock`].size, 0);
  assert.deepEqual(record.reads.at(-1).repositories, []);
});

test("deletes accepted and never collected fail the destroy closed after its retries, with every read in the record", async () => {
  const fake = cloudflareStage({ emptyEnd: true, collectAfter: 1_000 });
  const error = await account(fake.fetcher)
    .destroy()
    .then(
      () => assert.fail("the destroy succeeded"),
      (caught) => caught,
    );
  assert.match(
    error.message,
    /remain after teardown: registry repository .* \(7 tags, 2 digest entries\)$/u,
  );
  assert.equal(error.record.reads.length, 7);
  assert.equal(error.record.failedDeletes, 0);
  assert.deepEqual(error.record.registryDeletes[0].delete, { accepted: 2, absent: 0, refused: 0 });
  assert.deepEqual(error.record.reads.at(-1).repositories[0].read, { ok: 9, absent: 0, other: 0 });
});

test("a read-back the budget cuts between its reads stops as unread, never as a read that failed", async () => {
  const fake = cloudflareStage({ emptyEnd: true, collectAfter: 1_000 });
  const start = Date.UTC(2026, 10, 27, 20);
  const deadline = start + 15 * 60_000;
  let clock = start;
  let deleted = false;
  let readBack = false;
  let jumped = false;
  // After the deletes, the read-back's first read by reference leaves no room for the next one.
  const fetcher = async (url, init) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "registry.cloudflare.com" && init?.method === "DELETE") deleted = true;
    if (deleted && pathname === "/v2/_catalog") readBack = true;
    const answer = await fake.fetcher(url, init);
    if (readBack && !jumped && pathname.includes("/manifests/")) {
      jumped = true;
      clock = deadline - 20_000;
    }
    return answer;
  };
  const error = await account(fetcher, { deadline, now: () => clock })
    .destroy()
    .then(
      () => assert.fail("the destroy succeeded"),
      (caught) => caught,
    );
  assert.match(
    error.message,
    /^Emulated upstream teardown could not read back what remains: .*time budget is spent/u,
  );
  assert.equal(error.record.readBack, "not-completed");
});

test("a colon entry that is not a sha256 digest still stops the read closed, and says it looked like one", async () => {
  for (const [entry, digestShaped] of [
    [`sha256:${"A".repeat(64)}`, true],
    [`sha256:${"a".repeat(63)}`, true],
    [`sha512:${"a".repeat(128)}`, true],
    ["latest:v1/x", false],
  ]) {
    const fake = cloudflareStage({ emptyEnd: true }, ["h1", entry]);
    const error = await destroyOn(fake).then(
      () => assert.fail(`${entry}: the destroy succeeded`),
      (caught) => caught,
    );
    assert.match(error.message, /answered a tag it cannot name/u, entry);
    assert.equal(error.record.tagRead.tag.digestShaped, digestShaped, entry);
    // The read stopped before any delete.
    assert.equal(fake.live.manifests[`acct/${prefix}-mock`].size, 2, entry);
  }
});

test("a container the platform stops while starting fails with the platform's own reason", async () => {
  const reason =
    "There is no container instance that can be provided to this Durable Object, try again later";
  let starts = 0;
  const container = {
    running: false,
    start() {
      starts += 1;
    },
    monitor: () => Promise.reject(new Error(reason)),
    getTcpPort: () => ({ fetch: () => Promise.reject(new Error("nothing listens")) }),
  };
  const starter = mockStarter(container, {}, async () => {});
  await assert.rejects(starter.ready(), new RegExp(`^Error: ${reason}$`, "u"));
  // The next call starts the container again instead of keeping the failure.
  await assert.rejects(starter.ready(), new RegExp(`^Error: ${reason}$`, "u"));
  assert.equal(starts, 2);
});
