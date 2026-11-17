import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectAccountViewTrace,
  type AccountViewSpan,
} from "../.upstream/e2e/support/account-view-query-trace.ts";

const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const serverSpanId = "server";
const trace = (executions: number) => {
  const rows: AccountViewSpan[] = [];
  const span = (id: string, parent: string | null, name: string, start: number, duration = 1) => {
    rows.push({
      traceId,
      span: {
        spanId: id,
        parentSpanId: parent,
        operationName: name,
        startTime: new Date(start).toISOString(),
        durationMs: duration,
        tags:
          name === "http.server POST"
            ? {
                "app.ui.query.phase_order": [
                  "session_access",
                  ...Array(executions).fill("caller_accounts"),
                  "dispatch",
                ].join(","),
              }
            : {},
      },
    });
  };
  span("client", null, "POST /_executor/api/query", 0, 1000);
  span(serverSpanId, "client", "http.server POST", 1, 998);
  for (let index = 0; index < executions; index++) {
    const prefix = `pass-${index}`;
    const start = 10 + index * 100;
    span(prefix, serverSpanId, "sdk.data.query", start, 80);
    span(`${prefix}-cloud`, prefix, "runtime.cloud.query", start + 1, 78);
    span(`${prefix}-catalog`, serverSpanId, "catalog.lookup", start + 20);
    for (let source = 0; source < 6; source++) {
      const id = `${prefix}-invoke-${source}`;
      const cloud = source === 0 ? `${prefix}-cloud` : `${prefix}-call-${source}`;
      if (source !== 0) span(cloud, prefix, "runtime.cloud.call", start + 2, 70);
      span(id, cloud, "runtime.app.remote.invoke", start + 5, 60);
      span(`${id}-release`, cloud, "runtime.app.rpc.release", start + 65);
    }
  }
  return rows;
};

const input = { traceId, serverSpanId, sources: [5, 5] };

test("a complete single account-view execution is accepted", () => {
  assert.equal(inspectAccountViewTrace(trace(1), input).executions, 1);
});

test("a complete speculative execution followed by one fresh fallback is accepted", () => {
  assert.equal(inspectAccountViewTrace(trace(2), input).executions, 2);
});

const partial = /The completed query trace is partial or has missing parents/;
for (const executions of [1, 2]) {
  const rejects = (name: string, change: (rows: AccountViewSpan[]) => AccountViewSpan[]) => {
    test(`${executions} execution trace rejects ${name}`, () => {
      assert.throws(() => inspectAccountViewTrace(change(trace(executions)), input), partial);
    });
  };
  rejects("an absent request span", (rows) =>
    rows.filter(({ span }) => span.spanId !== serverSpanId),
  );
  rejects("a missing parent", (rows) =>
    rows.map((row, index) =>
      index === 3 ? { ...row, span: { ...row.span, parentSpanId: "absent" } } : row,
    ),
  );
  rejects("an explicit missing-parent placeholder", (rows) =>
    rows.map((row, index) =>
      index === 3 ? { ...row, span: { ...row.span, operationName: "[missing parent abc]" } } : row,
    ),
  );
  rejects("an incomplete final execution", (rows) => rows.slice(0, -1));
  rejects("a missing catalog lookup", (rows) =>
    rows.filter(({ span }) => span.spanId !== "pass-0-catalog"),
  );
  rejects("an extra catalog lookup", (rows) => [
    ...rows,
    { ...rows[4]!, span: { ...rows[4]!.span, spanId: "extra-catalog" } },
  ]);
  rejects("a missing query root", (rows) => rows.filter(({ span }) => span.spanId !== "pass-0"));
  rejects("an unfinished dispatch", (rows) =>
    rows.map((row) =>
      row.span.spanId === serverSpanId ? { ...row, span: { ...row.span, tags: {} } } : row,
    ),
  );
  rejects("a foreign trace", (rows) =>
    rows.map((row, index) => (index === 3 ? { ...row, traceId: "foreign" } : row)),
  );
  rejects("duplicate span IDs", (rows) => [...rows, rows[3]!]);
  rejects("two releases for the same invocation", (rows) =>
    rows.map((row) =>
      row.span.spanId === "pass-0-invoke-1-release"
        ? { ...row, span: { ...row.span, parentSpanId: "pass-0-cloud" } }
        : row,
    ),
  );
}

test("a fallback cannot hide an incomplete execution behind twelve total releases", () => {
  const rows = trace(2).map((row) =>
    row.span.spanId === "pass-1-invoke-5-release"
      ? { ...row, span: { ...row.span, parentSpanId: "pass-0-call-5" } }
      : row,
  );
  assert.throws(() => inspectAccountViewTrace(rows, input), partial);
});

test("more than one fresh fallback is rejected", () => {
  assert.throws(() => inspectAccountViewTrace(trace(3), input), partial);
});

test("the deterministic fallback requires two executions", () => {
  assert.throws(
    () => inspectAccountViewTrace(trace(1), { ...input, requiredExecutions: 2 }),
    partial,
  );
  assert.equal(
    inspectAccountViewTrace(trace(2), { ...input, requiredExecutions: 2 }).executions,
    2,
  );
});
