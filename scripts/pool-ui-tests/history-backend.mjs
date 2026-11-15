import assert from "node:assert/strict";
import { createServer } from "node:http";
import { overviewFixture } from "./overview-fixture.mjs";

/** Loopback history data and revision transport; held replies expose cancellation to the test. */
export async function historyBackend({ initialRequests = 1, pageSize = Infinity } = {}) {
  const first = "2026-11-04T11:28:37.250Z";
  const initial = Array.from({ length: initialRequests }, (_, index) =>
    new Date(Date.parse(first) + index * 1000).toISOString(),
  );
  const times = [...initial];
  const requests = [];
  const streams = new Set();
  const waiting = new Map();
  const notify = () => {
    for (const listener of waiting.keys()) listener();
  };
  const waitFor = (predicate, { name = "history fixture state", timeout = 10_000 } = {}) =>
    new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        waiting.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const state = requests
          .map(
            ({ phase, aborted, response }) =>
              `phase=${phase} aborted=${aborted} ended=${response.writableEnded} destroyed=${response.destroyed}`,
          )
          .join("; ");
        finish(
          new Error(
            `Timed out waiting for ${name} after ${timeout}ms; held=${held ?? "none"}; ${state || "no requests"}`,
          ),
        );
      }, timeout);
      const check = () => {
        try {
          if (predicate()) finish();
        } catch (error) {
          finish(error);
        }
      };
      waiting.set(check, () =>
        finish(new Error(`History fixture closed while waiting for ${name}`)),
      );
      check();
    });
  let held;
  const revisions = [
    "apps",
    "membership",
    "session",
    "pool-usage",
    "pool-samples",
    "pool-prices",
  ].map((topic) => ({ topic, resource: "fixture", revision: "1" }));
  const heads = { revisions, identity: "fixture-viewer" };
  const transport = createServer(async (request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path === "/_executor/api/changes/current") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(heads));
    } else if (path === "/_executor/api/changes") {
      response.setHeader("content-type", "text/event-stream");
      streams.add(response);
      response.on("close", () => streams.delete(response));
      response.write(
        `event: current\ndata: ${JSON.stringify({ kind: "current", ...heads, snapshotRequired: true })}\n\n`,
      );
    } else if (path === "/_executor/api/query" || path === "/_executor/api/pool-usage/series") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { name, input } = JSON.parse(body);
      assert.ok(
        name === "publicHistory" || path.endsWith("/series"),
        "Only history reads reach the fixture",
      );
      const kind = name === "publicHistory" ? "history" : "series";
      const phase =
        kind === "series" ? "series" : input.from.startsWith("1970") ? "discovery" : "bounded";
      const entry = {
        kind,
        phase,
        input,
        aborted: false,
        response,
        answer: () => {
          response.setHeader("content-type", "application/json");
          if (kind === "series") {
            const value = overviewFixture(input, {
              total: { requests: times.length, tokens: { total: 110 * times.length } },
              models: [{ provider: "codex", model: "Synthetic model" }],
            }).people;
            value.asOf = "2026-11-09T08:00:00.000Z";
            value.coverage = {
              ...value.coverage,
              firstAt: first,
              lastAt: times.at(-1),
              capturedThrough: first,
            };
            response.end(JSON.stringify(value));
          } else {
            const records = times
              .map((timestamp, i) => ({
                id: String(i + 1).padStart(64, "0"),
                timestamp,
                person: null,
                request_id: "synthetic-" + i,
                provider: "codex",
                model: "Synthetic model",
                endpoint: "/v1/responses",
                api_type: "responses",
                service_tier: null,
                input_tokens: "100",
                output_tokens: "10",
                cache_read_tokens: "0",
                cache_write_tokens: "0",
                reasoning_tokens: "0",
                total_tokens: "110",
                token_quality: "complete",
                latency_ms: "100",
                failed: false,
                status_code: 200,
                cost: null,
                currency: null,
                cost_basis: "unpriced",
                attribution: "unknown",
              }))
              .filter(
                (record) =>
                  record.timestamp >= input.from &&
                  record.timestamp < input.to &&
                  (!input.after ||
                    record.timestamp > input.after.timestamp ||
                    (record.timestamp === input.after.timestamp && record.id > input.after.id)),
              );
            const page = records.slice(0, pageSize);
            const last = page.at(-1);
            response.end(
              JSON.stringify({
                ok: true,
                value: {
                  records: page,
                  next:
                    records.length > page.length && last
                      ? { timestamp: last.timestamp, id: last.id }
                      : null,
                },
              }),
            );
          }
        },
      };
      requests.push(entry);
      response.on("close", () => {
        entry.aborted = !response.writableEnded;
        notify();
      });
      if (held !== phase) entry.answer();
      notify();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => transport.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${transport.address().port}`;
  return {
    requests,
    waitFor,
    hold(phase) {
      held = phase;
    },
    release() {
      const previous = held;
      held = undefined;
      for (const entry of requests)
        if (entry.phase === previous && !entry.response.destroyed && !entry.response.writableEnded)
          entry.answer();
    },
    add() {
      times.push("2026-11-09T08:01:02.000Z");
    },
    change(topic = "pool-usage") {
      const hint = revisions.find((entry) => entry.topic === topic);
      assert.ok(hint);
      hint.revision = String(Number(hint.revision) + 1);
      for (const stream of streams)
        stream.write(`event: changed\ndata: ${JSON.stringify({ kind: "changed", hint })}\n\n`);
    },
    reset() {
      times.splice(0, times.length, ...initial);
    },
    origin,
    async close() {
      for (const cancel of waiting.values()) cancel();
      for (const stream of streams) stream.end();
      transport.closeAllConnections();
      await new Promise((resolve) => transport.close(resolve));
    },
  };
}
