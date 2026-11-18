import assert from "node:assert/strict";
import { test } from "node:test";
import { failureReport } from "./public-report.ts";

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
  assert.match(report.publicText, /rules=pool-container-image-not-pinned@PoolContainer/u);
  assert.doesNotMatch(report.publicText, new RegExp(account, "u"));
  assert.match(report.detail, new RegExp(account, "u"));
});

test("an untagged error shows its class in public and its message only in private", () => {
  const report = failureReport(new TypeError(`fetch failed for https://${host}/v1`));
  assert.equal(
    report.publicText,
    "Release stopped: TypeError (the message is in the sealed detail)",
  );
  assert.match(report.detail, new RegExp(host, "u"));
});
