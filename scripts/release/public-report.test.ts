import assert from "node:assert/strict";
import { test } from "node:test";
import { propChanges } from "./plan-check.ts";
import { errorKind, failureReport, progressTracker } from "./public-report.ts";

const host = "pool.example.internal";
const account = "0123456789abcdef0123456789abcdef";

test("a tagged refusal says its reason in public and keeps names, ids and values private", () => {
  const refusal = {
    _tag: "WireRefused",
    resource: `container application ${account}`,
    method: "PATCH",
    path: `/accounts/${account}/containers/applications/x`,
    field: "method",
    value: "PATCH",
    why: "A rollout restarts the root.",
    fix: "Restart the root in its own named step.",
    detail: { host },
  };
  const report = failureReport({ _tag: "Fail", cause: refusal });
  assert.match(report.publicText, /WireRefused: field=method why=A rollout restarts the root\./u);
  assert.doesNotMatch(report.publicText, new RegExp(`${account}|${host}|PATCH`, "u"));
  assert.match(report.detail, new RegExp(account, "u"));
  assert.match(report.detail, new RegExp(host, "u"));
});

test("a plan refusal names its rules and resources, not the changed values", () => {
  const report = failureReport({
    _tag: "PlanRefused",
    violations: [
      {
        rule: "pool-container-image-not-pinned",
        fqn: "PoolContainer",
        change: [`props.image: registry/${account}/pool@sha256:aa -> built`],
      },
    ],
  });
  assert.match(
    report.publicText,
    /rules=pool-container-image-not-pinned@PoolContainer\[props\.image\]/u,
  );
  assert.doesNotMatch(report.publicText, new RegExp(account, "u"));
  assert.match(report.detail, new RegExp(account, "u"));
});

test("a refusal's key paths print once each and capped, and an id or a data key never passes for a name", () => {
  // Starts with a letter, so only its hex run tells it from a name.
  const id = "abcdef0123456789".repeat(2);
  const report = failureReport({
    _tag: "PlanRefused",
    violations: [
      {
        rule: "unreviewed-replace",
        fqn: "Router",
        change: [
          ...Array.from({ length: 10 }, (_, index) => `props.env.NAME_${index}: absent -> x`),
          "props.env.NAME_0: x -> absent",
          `bindings.${id}.namespaceId: a -> b`,
        ],
      },
      {
        rule: "unreviewed-replace",
        fqn: "Telemetry",
        change: [`bindings.${id}.namespaceId: a -> b`, `props.headers.${host}: absent -> x`],
      },
    ],
  });
  const names = Array.from({ length: 8 }, (_, index) => `props.env.NAME_${index}`).join(",");
  assert.match(report.publicText, new RegExp(`@Router\\[${names},\\+3 more\\]`, "u"));
  assert.match(report.publicText, /@Telemetry\[bindings\.\{key\},props\.headers\.\{key\}\]/u);
  assert.doesNotMatch(report.publicText, new RegExp(`${id}|${host}|example`, "u"));
});

/** The key paths the public line prints for the lines `propChanges` writes for this change. */
const printed = (old: unknown, next: unknown) => {
  const change = propChanges(old, next);
  const { publicText } = failureReport({
    _tag: "PlanRefused",
    violations: [{ rule: "unreviewed-replace", fqn: "X", change }],
  });
  return { change, paths: /@X\[(.*)\]$/mu.exec(publicText)?.[1] ?? publicText };
};

test("a key stays whole: a record keyed by data prints {key} and nothing after it", () => {
  // A Worker's JSON env value is a record keyed by whatever the stack puts in it.
  const byHost = printed(
    { env: { ORIGIN_REGION: { "api.example.org": "us", "ops@example.org": "eu" } } },
    { env: { ORIGIN_REGION: { "api.example.org": "eu", "ops@example.org": "us" } } },
  );
  assert.deepEqual(byHost.change, [
    'props.env.ORIGIN_REGION["api.example.org"]: <withheld> -> <withheld>',
    'props.env.ORIGIN_REGION["ops@example.org"]: <withheld> -> <withheld>',
  ]);
  assert.equal(byHost.paths, "props.env.ORIGIN_REGION.{key}");
  // A plain name after a quoted key is still under data, so it does not print either.
  const nested = printed(
    { hosts: { "app.my-co.example.com": { region: "eu" } } },
    { hosts: { "app.my-co.example.com": { region: "us" } } },
  );
  assert.deepEqual(nested.change, ['props.hosts["app.my-co.example.com"].region: eu -> us']);
  assert.equal(nested.paths, "props.hosts.{key}");
  assert.equal(
    printed({ owners: { "jane.doe@example.com": "admin" } }, { owners: {} }).paths,
    "props.owners.{key}",
  );
  // Paths of plain names print as they always have, in the sealed detail and in public.
  const plain = printed(
    { instanceType: "basic", env: { MODE: "a" } },
    { instanceType: "standard", env: { MODE: "b" } },
  );
  assert.deepEqual(plain.change, [
    "props.env.MODE: <withheld> -> <withheld>",
    "props.instanceType: basic -> standard",
  ]);
  assert.equal(plain.paths, "props.env.MODE,props.instanceType");
});

test("a record key of digits never passes for an array position", () => {
  const address = printed({ peers: { "203.0.113.5": "a" } }, { peers: { "203.0.113.5": "b" } });
  assert.deepEqual(address.change, ['props.peers["203.0.113.5"]: a -> b']);
  assert.equal(address.paths, "props.peers.{key}");
  const id = printed(
    { projects: { "4721": { on: true } } },
    { projects: { "4721": { on: false } } },
  );
  assert.deepEqual(id.change, ['props.projects["4721"].on: true -> false']);
  assert.equal(id.paths, "props.projects.{key}");
  const position = printed({ routes: ["a", "b"] }, { routes: ["a", "c"] });
  assert.deepEqual(position.change, ["props.routes[1]: b -> c"]);
  assert.equal(position.paths, "props.routes[1]");
});

// Each record a provider the stack loads keys by data, in its real shape. Real keys are often
// hosts or addresses, which the shape rule already masks; each key here is shaped like a name, so
// only the record's own entry keeps it out, and removing the entry fails its test.
const dataKeyed: ReadonlyArray<{ record: string; old: object; next: object; key: string }> = [
  {
    record: "policies[0].resources",
    old: { policies: [{ effect: "allow", resources: { acme_account: "*" } }] },
    next: { policies: [{ effect: "allow", resources: { acme_account: { acme_zone: "*" } } }] },
    key: "acme",
  },
  {
    record: "headers",
    old: { headers: { Authorization: "a" } },
    next: { headers: {} },
    key: "Authorization",
  },
  {
    record: "header",
    old: { header: { Host: ["origin.example.org"] } },
    next: { header: { Host: ["edge.example.org"] } },
    key: "Host",
  },
  {
    record: "tags",
    old: { tags: { costCenter: "payments" } },
    next: { tags: {} },
    key: "costCenter",
  },
  {
    record: "labels",
    old: { labels: { owner: "jane" } },
    next: { labels: { owner: "joe" } },
    key: "owner",
  },
  {
    record: "metadata",
    old: { metadata: { customer: "acme" } },
    next: { metadata: {} },
    key: "customer",
  },
  {
    record: "customMetadata",
    old: { customMetadata: { acme_corp: { tier: "a" } } },
    next: { customMetadata: { acme_corp: { tier: "b" } } },
    key: "acme_corp",
  },
  {
    record: "meta",
    old: { meta: { town_hall: "a" } },
    next: { meta: { town_hall: "b" } },
    key: "town_hall",
  },
  {
    record: "reverseDns",
    old: { reverseDns: { mailhost: "mail.example.org" } },
    next: { reverseDns: { mailhost: "mx.example.org" } },
    key: "mailhost",
  },
  {
    record: "datasetCapabilities",
    old: { datasetCapabilities: { acme_prod_traces: { ingest: ["create"] } } },
    next: { datasetCapabilities: { acme_prod_traces: { ingest: ["create", "read"] } } },
    key: "acme_prod_traces",
  },
  {
    record: "variations",
    old: { variations: { holiday_banner: { color: "red" } } },
    next: { variations: { holiday_banner: { color: "blue" } } },
    key: "holiday_banner",
  },
  {
    record: "tools",
    old: { tools: { kx3n9ab2c4de: { enabled: true } } },
    next: { tools: { kx3n9ab2c4de: { enabled: false } } },
    key: "kx3n9ab2c4de",
  },
  {
    record: "triggers",
    old: { triggers: { checkout_acme: { name: "a" } } },
    next: { triggers: { checkout_acme: { name: "b" } } },
    key: "checkout_acme",
  },
  {
    record: "variables",
    old: { variables: { acme_api_key: { type: "string" } } },
    next: { variables: { acme_api_key: { type: "secret" } } },
    key: "acme_api_key",
  },
  {
    record: "entryIds",
    old: { entryIds: { customer_ids: "a" } },
    next: { entryIds: {} },
    key: "customer_ids",
  },
  {
    record: "reservations",
    old: { reservations: { printer_jane: "a" } },
    next: { reservations: { printer_jane: "b" } },
    key: "printer_jane",
  },
  {
    record: "poolWeights",
    old: { poolWeights: { kx3n9ab2c4de: 0.5 } },
    next: { poolWeights: { kx3n9ab2c4de: 1 } },
    key: "kx3n9ab2c4de",
  },
];

for (const { record, old, next, key } of dataKeyed)
  test(`nothing after a provider's \`${record.split(".").at(-1)}\` record prints`, () => {
    const { change, paths } = printed(old, next);
    assert.ok(
      change.some((line) => line.includes(key)),
      change.join("\n"),
    );
    assert.equal(paths, `props.${record}.{key}`);
  });

test("a record keyed by data is known whatever its case, and still names itself as a leaf", () => {
  const { paths } = printed(
    { Headers: { Authorization: "a" }, CUSTOMMETADATA: { acme_corp: 1 } },
    { Headers: { Authorization: "b" }, CUSTOMMETADATA: { acme_corp: 2 }, tags: ["team"] },
  );
  assert.equal(paths, "props.CUSTOMMETADATA.{key},props.Headers.{key},props.tags");
});

test("an untagged error shows its class in public and its message only in private", () => {
  const report = failureReport(new TypeError(`fetch failed for https://${host}/v1`));
  assert.equal(
    report.publicText,
    "Release stopped: TypeError (failed). The message is in the sealed detail.",
  );
  assert.match(report.detail, new RegExp(host, "u"));
});

// Alchemy's own event when a resource fails (Apply.ts emits these for every resource it works on).
const status = (fqn: string, type: string, value: string) => ({
  _tag: "apply.resource.status",
  fqn,
  id: fqn,
  type,
  status: value,
  message: `exit 1 from https://${host}/ready`,
});

test("a failure inside an Alchemy resource names the phase, the resource and the class", () => {
  const tracker = progressTracker();
  tracker.setPhase("apply");
  tracker.track(status("PoolWorker", "Cloudflare.Worker", "updating"));
  tracker.track(status("PoolWorker", "Cloudflare.Worker", "updated"));
  tracker.track(status("PoolBackendBudgetRuntimeReady", "Command.Exec", "running"));
  tracker.track(status("PoolBackendBudgetRuntimeReady", "Command.Exec", "fail"));
  const failure = Object.assign(new Error(`readiness failed at https://${host}/ready`), {
    name: "CommandExecError",
  });
  const report = failureReport({ _tag: "UnknownException", cause: failure }, tracker.context());
  assert.equal(
    report.publicText,
    "Release stopped in apply at PoolBackendBudgetRuntimeReady (Command.Exec): CommandExecError (failed). The message is in the sealed detail.",
  );
  assert.doesNotMatch(report.publicText, new RegExp(host, "u"));
  assert.match(report.detail, new RegExp(host, "u"));
});

test("with no resource failed yet, the ones in flight are named, and the kind says what to do", () => {
  const tracker = progressTracker();
  tracker.setPhase("apply");
  tracker.track(status("PreviewAuthSeed", "Command.Exec", "running"));
  const timeout = Object.assign(new Error("deadline"), { name: "TimeoutError" });
  assert.match(
    failureReport(timeout, tracker.context()).publicText,
    /^Release stopped in apply at PreviewAuthSeed \(Command\.Exec\): TimeoutError \(timeout\)/u,
  );
  assert.deepEqual(errorKind({ _tag: "ResponseError", status: 409 }), {
    errorClass: "ResponseError",
    kind: "conflict",
    status: 409,
  });
  assert.equal(errorKind({ _tag: "SchemaError" }).kind, "decode");
  assert.equal(errorKind({ status: 404 }).kind, "not found");
});
