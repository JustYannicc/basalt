import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const [{ readHostedLog, messageParts, entryTexts, hostedRecords, noReport }, { dataStepPassesIn }] =
  await Promise.all([load("e2e/support/hosted-log.ts"), load("e2e/support/data-steps.ts")]);

const summary = (step: string) =>
  JSON.stringify({
    step,
    mode: "report",
    run: "report:cloud",
    pass: 1,
    status: "complete",
    outcomes: {},
    owners: {},
  });
/** A JSON record on one line, as self-host and the Workers' own JSON writers print them. */
const jsonLine = (message: unknown, timestamp: string) =>
  `[Api] ${JSON.stringify({ message, level: "INFO", timestamp, annotations: {}, spans: {} })}`;
/** A hosted Effect record as the local runtime prints Effect's structured object. */
const inspected = (name: string, lines: readonly string[]) =>
  ["{", ...lines, "}"].map((line) => `[${name}] ${line}`);

const records = (text: string) =>
  readHostedLog(text).flatMap((entry: { kind: string; value?: unknown }) =>
    entry.kind === "record" ? [entry.value] : [],
  );

test("a data step summary reads the same from a JSON record and a printed hosted record", () => {
  const text = [
    jsonLine(
      `Data step pass finished: ${summary("10_profile_app_copies")}`,
      "2026-11-22T09:54:40.000Z",
    ),
    ...inspected("Api", [
      `  message: 'Data step pass finished: ${summary("10_profile_app_copies")}',`,
      "  level: 'INFO',",
      "  timestamp: '2026-11-22T09:54:50.081Z',",
      "  cause: undefined,",
      "  annotations: {},",
      "  spans: {},",
      "  fiberId: '#777'",
    ]),
  ].join("\n");
  const passes = dataStepPassesIn(text, "10_profile_app_copies");
  assert.deepEqual(
    passes.map((pass: { summary: { step: string; status: string }; loggedAt: number }) => [
      pass.summary.step,
      pass.summary.status,
      pass.loggedAt,
    ]),
    [
      ["10_profile_app_copies", "complete", Date.parse("2026-11-22T09:54:40.000Z")],
      ["10_profile_app_copies", "complete", Date.parse("2026-11-22T09:54:50.081Z")],
    ],
  );
});

test("a printed record keeps its place while another Worker writes inside it", () => {
  const text = [
    "[Api] {",
    `[Api]   message: 'Data step pass finished: ${summary("1_app_framework_pin")}',`,
    "[AppData] { type: 'alchemy.phase', name: 'alchemy.do.wait', durationMs: 0 }",
    "[Api]   timestamp: '2026-11-22T09:54:30.000Z',",
    "[Api]   cause: undefined",
    "[Api] }",
    `plain text: Data step pass finished: ${summary("2_app_framework_pin_catch_up")}`,
  ].join("\n");
  assert.deepEqual(
    readHostedLog(text).map((entry: { kind: string }) => entry.kind),
    ["record", "record", "line"],
  );
  assert.deepEqual(records(text)[1], {
    type: "alchemy.phase",
    name: "alchemy.do.wait",
    durationMs: 0,
  });
  assert.equal(dataStepPassesIn(text, "1_app_framework_pin").length, 1);
  assert.equal(dataStepPassesIn(text, "2_app_framework_pin_catch_up").length, 1);
});

test("a printed record keeps nested message parts, annotations and joined string pieces", () => {
  const text = [
    ...inspected("Api", [
      "  message: [",
      "    'production_ops.operation_refused',",
      "    {",
      "      guard: 'provider_apps_read',",
      "      reasonCode: 'account_must_remain_the_actor_s_personal_account'",
      "    }",
      "  ],",
      "  level: 'WARN',",
      "  timestamp: '2026-11-22T10:02:29.277Z',",
      "  cause: undefined,",
      "  annotations: {},",
      "  spans: {},",
      "  fiberId: '#7680'",
    ]),
    ...inspected("Api", [
      "  message: 'executor.request.context',",
      "  annotations: {",
      "    'executor.trace_id': '3ac72c6f8c0301295250e1c96365257a',",
      "    'executor.trace_sampled': true",
      "  },",
      // A long string with a line break prints as pieces joined by `+`.
      "  note: 'first line\\n' +",
      '    "it\'s the second"',
    ]),
  ].join("\n");
  const [refused, context] = records(text);
  assert.ok(JSON.stringify(refused).includes('"guard":"provider_apps_read"'));
  assert.deepEqual(messageParts(refused), ["production_ops.operation_refused"]);
  assert.deepEqual(context.annotations, {
    "executor.trace_id": "3ac72c6f8c0301295250e1c96365257a",
    "executor.trace_sampled": true,
  });
  assert.equal(context.note, "first line\nit's the second");
});

// Real line shapes from a Cloud run's log, with made-up identifiers. Workers write these with
// `console.log(JSON.stringify(...))`, so they carry no message.
const inventoryEnd =
  '[Api] {"inventory":"host-v1","run":"3f6d1c2a-7b4e-4c1d-9a8f-2e5b6c7d8e9f","event":"end","complete":true,"sha256":"' +
  "ab".repeat(32) +
  '","chunks":2,"bytes":8651,"coverage":["accounts","accountAccess","accountGroups","appAccess","appGroups","groups","groupMembers","members","links","connections","connectionAccess","connectionGroups","workflowAccounts","webhookAccounts","webhooks","defaults","pools"],"excluded":["home-state","durable-object-state"],"migrationGo":false}';
const compilerPhase =
  '[AppCompiler] {"type":"executor.compiler.phase","traceId":"0123456789abcdef0123456789abcdef","attempt":"11111111-2222-4333-8444-555555555555","isolate":"66666666-7777-4888-8999-aaaaaaaaaaaa","sourceDigest":null,"phase":"received","elapsedMs":0}';
const runnerProgress =
  '[AppData] {"type":"executor.runner.progress","inspection":false,"traceId":null,"attempt":"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff","isolate":"12121212-3434-4565-8787-909090909090","app":null,"build":null,"sequence":1,"phase":"worker-code","status":"started","elapsedMs":9,"activeInvocations":1,"truncated":false}';
const requestContext = inspected("Api", [
  "  message: 'executor.request.context',",
  "  level: 'INFO',",
  "  timestamp: '2026-11-22T12:23:58.200Z',",
  "  annotations: { 'executor.trace_id': '0123456789abcdef0123456789abcdef' }",
]);

test("a JSON line with no message survives as its text, and reads as its record", () => {
  const text = [...requestContext, inventoryEnd, "plain Alchemy text"].join("\n");
  const entries = readHostedLog(text);
  assert.deepEqual(
    entries.map((entry: { text: string }) => entry.text),
    [requestContext.join("\n"), inventoryEnd, "plain Alchemy text"],
  );
  // What `logMessages` returns: the inventory line is kept as written, not dropped for having no
  // message.
  assert.deepEqual(entries.flatMap(entryTexts), [
    "executor.request.context",
    inventoryEnd,
    "plain Alchemy text",
  ]);
  const [, inventory] = hostedRecords(text);
  assert.equal(inventory.inventory, "host-v1");
  assert.equal(inventory.event, "end");
  assert.equal(inventory.run, "3f6d1c2a-7b4e-4c1d-9a8f-2e5b6c7d8e9f");
});

test("compiler phase and runner progress lines read as their records, every field intact", () => {
  const records = hostedRecords([compilerPhase, runnerProgress].join("\n"));
  assert.deepEqual(records, [
    JSON.parse(compilerPhase.slice(compilerPhase.indexOf("{"))),
    JSON.parse(runnerProgress.slice(runnerProgress.indexOf("{"))),
  ]);
  assert.deepEqual(Object.keys(records[0]), [
    "type",
    "traceId",
    "attempt",
    "isolate",
    "sourceDigest",
    "phase",
    "elapsedMs",
  ]);
});

test("a reader that finds no report says how much of the log it saw and could not decode", () => {
  const cut = '[Api] {"inventory":"host-v1","run":"3f6d1c2a-7b4e-4c1d-9a8f-2e5b6c7d8e9f","event":';
  assert.equal(
    noReport("inventory report", [...requestContext, cut].join("\n"), "host-v1", 0),
    "No inventory report in 7 hosted log lines; 1 of 1 lines naming it could not be decoded",
  );
  assert.equal(
    noReport("inventory report", inventoryEnd, "host-v1", 1),
    "No inventory report in 1 hosted log lines; 0 of 1 lines naming it could not be decoded",
  );
  assert.equal(
    noReport("new 10_profile_app_copies summary", "", "Data step pass finished: ", 0),
    "No new 10_profile_app_copies summary in 0 hosted log lines; 0 of 0 lines naming it could not be decoded",
  );
});

test("a record still being written, or one that isn't plain data, stays as its lines", () => {
  const unfinished = ["[Api] {", "[Api]   message: 'executor.request.context',"].join("\n");
  assert.deepEqual(readHostedLog(unfinished), [{ kind: "line", text: "[Api] {" }]);
  const unknown = inspected("Api", ["  message: 'x',", "  value: Symbol(hidden)"]).join("\n");
  assert.deepEqual(
    readHostedLog(unknown).map((entry: { kind: string }) => entry.kind),
    ["line", "line", "line", "line"],
  );
});
