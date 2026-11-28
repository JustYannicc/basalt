import assert from "node:assert/strict";
import { test } from "node:test";
import { installRoutePeer, routePeerInstallMs, servingImage } from "./route-peer-intercept.ts";

const target = (imageInput: string) => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "slot",
  applicationId: "application",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: "sha256:" + "a".repeat(64),
  imageInput,
});
const record = (imageInput: string) => ({ target: target(imageInput), fenced: false });

test("the reachable runtimes count as one image only when the selection's active, candidate and draining agree", () => {
  const one = "0123456789abcdef";
  const two = "fedcba9876543210";
  const root = "1111111111111111";
  assert.equal(servingImage(root, undefined), root);
  assert.equal(servingImage("", undefined), null);
  assert.equal(servingImage(root, { epoch: 1, active: record(one) }), one);
  assert.equal(servingImage(root, { epoch: 2, active: record(one), candidate: record(two) }), null);
  assert.equal(servingImage(root, { epoch: 3, active: record(one), draining: record(two) }), null);
  assert.equal(
    servingImage(root, {
      epoch: 4,
      active: record(two),
      candidate: record(two),
      draining: record(two),
    }),
    two,
  );
  // An unreadable selection is never taken as agreement.
  assert.equal(servingImage(root, { epoch: "x" }), null);
});

test("a steady-state production fleet passes: one selected runtime, whatever image the root or the other colour runs", () => {
  // The root container keeps its pinned image and the previous colour stays bound to its old one;
  // neither takes management calls while a runtime is selected.
  assert.equal(
    servingImage("1111111111111111", { epoch: 9, active: record("0123456789abcdef") }),
    "0123456789abcdef",
  );
});

/** A pool container that records every intercept and answers the route peer's as `answer` says. */
const container = (answer: () => Promise<void>, exportName = "PoolRoutePeer") => {
  const hosts: string[] = [];
  const props: unknown[] = [];
  return {
    hosts,
    props,
    ctx: {
      exports: {
        [exportName]: (options: { props: unknown }) => {
          props.push(options.props);
          return "peer";
        },
      },
      container: {
        interceptOutboundHttp: (host: string) => {
          hosts.push(host);
          return answer();
        },
      },
    },
  };
};
const pending = (calls: ReadonlyArray<{ arguments: unknown[] }>) =>
  calls.filter((call) => call.arguments[0] === "POOL_ROUTE_PEER_INTERCEPT_PENDING").length;

test("the route intercept catches route-peer.internal only, with its pool's own props, and a healthy install never waits", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const pool = container(() => Promise.resolve());
  const started = performance.now();
  await installRoutePeer(pool.ctx, "pool-1");
  // Every other host the container dials, an unrouted credential's provider among them, goes out
  // as before: this is the only intercept the hook installs.
  assert.deepEqual(pool.hosts, ["route-peer.internal"]);
  assert.deepEqual(pool.props, [{ pool: "pool-1" }]);
  assert.equal(errors.mock.callCount(), 0);
  assert.ok(performance.now() - started < routePeerInstallMs / 10);
});

test("without a PoolRoutePeer export, as after a rename, or without a container, nothing is intercepted", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const renamed = container(() => Promise.resolve(), "PoolRoutePeers");
  await installRoutePeer(renamed.ctx, "pool-1");
  assert.deepEqual(renamed.hosts, []);
  const bare = container(() => Promise.resolve());
  await installRoutePeer({ exports: bare.ctx.exports }, "pool-1");
  assert.deepEqual(bare.props, []);
  assert.equal(errors.mock.callCount(), 0);
});

test("an install that throws, at once or later, leaves the start going on with the pending line", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  for (const answer of [
    () => Promise.reject(new Error("intercept refused")),
    () => {
      throw new Error("intercept refused");
    },
  ]) {
    errors.mock.resetCalls();
    await installRoutePeer(container(answer).ctx, "pool-1");
    assert.equal(pending(errors.mock.calls), 1);
  }
});

test("an install that never answers ends at its bound with the pending line", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const started = performance.now();
  await installRoutePeer(container(() => new Promise<void>(() => {})).ctx, "pool-1", 50);
  const waited = performance.now() - started;
  assert.ok(waited >= 45 && waited < 2_000, String(waited));
  assert.equal(pending(errors.mock.calls), 1);
});

test("an install that fails after its bound is never an unhandled rejection", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  context.after(() => process.off("unhandledRejection", record));
  let fail!: () => void;
  const late = new Promise<void>((_, reject) => {
    fail = () => reject(new Error("late intercept failure"));
  });
  await installRoutePeer(container(() => late).ctx, "pool-1", 20);
  fail();
  // Node reports an unhandled rejection once the microtasks drain: the next macrotask sees it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(pending(errors.mock.calls), 1);
});
