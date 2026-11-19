import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(report.publicText, /rules=pool-container-image-not-pinned@PoolContainer/u);
  assert.doesNotMatch(report.publicText, new RegExp(account, "u"));
  assert.match(report.detail, new RegExp(account, "u"));
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
