export { ModelLifetimeNode } from "./model-lifetime-node.mjs";
import { DurableObject } from "cloudflare:workers";
import { NativeStreams } from "../../src/pool/native-streams.ts";
import { nativeResponse } from "../../src/pool/native-response.worker.ts";
import { forwardPoolRequest } from "../../src/pool/forward.worker.ts";
import { RuntimeSlotRouter } from "../../src/pool/runtime-slots/router.ts";
import {
  RuntimeSlotStorage,
  nativeMembershipKey,
  slotSelectionKey,
} from "../../src/pool/runtime-slots/storage.ts";
import { SlotStreams } from "../../src/pool/runtime-slots/streams.ts";
import { SlotRetirement } from "../../src/pool/runtime-slots/retirement.ts";
import { executionKey } from "../../src/pool/runtime-slots/contract.ts";

const identity = (name) => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: name,
  applicationId: `app-${name}`,
  applicationVersion: "1",
  instanceId: `instance-${name}`,
  imageDigest: `sha256:${(name === "old" ? "a" : "b").repeat(64)}`,
  imageInput: `image-${name}`,
  bootId: `boot-${name}`,
});
const old = identity("old"),
  candidate = identity("candidate");
const code = { candidate: "a".repeat(40), workerInput: "b".repeat(64) };
const policy = {
  pool: "pool",
  organization: "organization",
  revision: 1,
  accounts: ["account"],
  dirty: false,
  expiresAt: Date.now() + 3600_000,
};

export class Proxy extends DurableObject {
  terminals = { starts: [], finishes: [] };
  waiters = new Set();
  retired = [];
  constructor(ctx, env) {
    super(ctx, env);
    const notify = () => {
      if (this.empty()) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    };
    class ObservedStreams extends NativeStreams {
      acquire(...args) {
        const lease = super.acquire(...args);
        return {
          ...lease,
          release() {
            lease.release();
            notify();
          },
        };
      }
    }
    class ObservedSlots extends SlotStreams {
      acquire(...args) {
        const pending = super.acquire(...args),
          release = pending.lease.release;
        pending.lease.release = () => {
          release();
          notify();
        };
        return pending;
      }
    }
    this.native = new ObservedStreams();
    this.model = new ObservedStreams();
    this.slots = new ObservedSlots();
    this.storage = new RuntimeSlotStorage(ctx.storage);
    const health = async (identity) => ({ identity, policyLeaseUntil: performance.now() + 1500 });
    this.driver = {
      health,
      fetch: async (_identity, request) => env.NODE.getByName("node").fetch(request),
      retire: async (_target, identity) => {
        this.retired.push(identity.bootId);
      },
    };
    this.router = new RuntimeSlotRouter({
      controllerId: "controller",
      driver: this.driver,
      storage: this.storage,
      streams: this.slots,
      clock: { now: Date.now, monotonic: () => performance.now() },
      defer: (work) => ctx.waitUntil(work),
      wrap: nativeResponse,
    });
    this.retirement = new SlotRetirement(this.storage, this.driver, this.slots, {
      now: Date.now,
      monotonic: () => performance.now(),
    });
  }
  state() {
    return {
      native: this.native.active,
      model: this.model.active,
      old: this.slots.active(executionKey(old)),
      candidate: this.slots.active(executionKey(candidate)),
      retired: this.retired,
    };
  }
  empty() {
    return (
      this.native.active === 0 &&
      this.model.active === 0 &&
      this.slots.active(executionKey(old)) === 0 &&
      this.slots.active(executionKey(candidate)) === 0
    );
  }
  async fetch(request) {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/seed") {
      await this.ctx.storage.put(nativeMembershipKey, {
        pool: {
          ...policy,
          native: true,
          checkedAt: Date.now(),
          installedRevision: 1,
          installedUntil: policy.expiresAt,
        },
      });
      await this.ctx.storage.put(slotSelectionKey, {
        epoch: 1,
        controllerCode: code,
        active: { target: old, identity: old, fenced: false },
      });
      return Response.json(this.state());
    }
    if (path.startsWith("/node-"))
      return this.env.NODE.getByName("node").fetch(
        new Request("https://node" + path + url.search, request),
      );
    if (path === "/state") return Response.json(this.state());
    if (path === "/terminals") return Response.json(this.terminals);
    if (path === "/settled") {
      if (!this.empty()) await new Promise((resolve) => this.waiters.add(resolve));
      return Response.json(this.state());
    }
    if (path === "/revoke") {
      this.native.abortAll();
      this.model.abortAll();
      return Response.json(this.state());
    }
    if (path === "/promote") {
      await this.ctx.storage.put(slotSelectionKey, {
        epoch: 2,
        controllerCode: code,
        active: { target: candidate, identity: candidate, fenced: false },
        draining: { target: old, identity: old, fenced: false },
      });
      return Response.json(this.state());
    }
    if (path === "/retire") {
      try {
        return Response.json(await this.retirement.run("draining", "retire-old"));
      } catch (error) {
        return Response.json({ reason: error.reason }, { status: 409 });
      }
    }
    return forwardPoolRequest(request, 8317, {
      env: {
        POOL_APP_SIGNING_KEY: "ab".repeat(32),
        ...(path === "/v1/responses" && this.env.TERMINAL_RECORDING !== "disabled"
          ? { POOL_MODEL_HISTORY_ENABLED: "true" }
          : {}),
      },
      ...(this.env.TERMINAL_RECORDING === "enabled"
        ? {
            terminal: {
              start: async (input) => {
                this.terminals.starts.push(input);
              },
              finish: async (id, result) => {
                this.terminals.finishes.push({ id, ...result });
              },
            },
          }
        : {}),
      streams: this.model,
      memberships: {
        configured: async () => !url.searchParams.has("unleased"),
        authority: async () => policy,
      },
      appModel: { pool: "pool", person: "person", keyId: "key" },
      computers: {
        nativeModel: async (request) => {
          const lease = this.native.acquire("computer", "pool", request.signal);
          return {
            ...lease,
            pool: "pool",
            person: "person",
            keyId: "key",
            request: new Request(request, {
              headers: this.env.MODEL_DRAIN
                ? {
                    ...Object.fromEntries(request.headers),
                    "Sec-WebSocket-Protocol": "basalt.model-drain.v1",
                  }
                : request.headers,
              signal: lease.signal,
            }),
          };
        },
      },
      lifecycle: Promise.resolve({
        warm: async () => ({ boot_id: "boot-old", started_at: "fixture" }),
      }),
      protection: { admit() {} },
      route: (request, port, pool, legacy, before) =>
        url.searchParams.has("legacy")
          ? legacy(request, () => {})
          : this.router.forward(
              pool,
              request,
              port,
              async (signal) => new Request(request, { signal }),
              before,
            ),
      fetch: (request) => this.env.NODE.getByName("node").fetch(request),
      defer: (work) => this.ctx.waitUntil(work),
    });
  }
}
export default {
  fetch(request, env) {
    return env.PROXY.getByName("proxy").fetch(request);
  },
};
