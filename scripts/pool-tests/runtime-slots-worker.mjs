import { DurableObject } from "cloudflare:workers";
import { RuntimeSlots } from "../../src/pool/runtime-slots/controller.ts";
import { RuntimeSlotRouter } from "../../src/pool/runtime-slots/router.ts";
import {
  RuntimeSlotStorage,
  nativeMembershipKey,
  slotSelectionKey,
} from "../../src/pool/runtime-slots/storage.ts";
import { SlotStreams } from "../../src/pool/runtime-slots/streams.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";
import { nativeResponse } from "../../src/pool/native-response.worker.ts";
import {
  membershipPrefix,
  policyHeader,
  policyUsePrefix,
} from "../../src/pool/membership-contract.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";

const identity = (name) => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: name,
  applicationId: `application-${name}`,
  applicationVersion: "1",
  instanceId: `instance-${name}`,
  imageDigest: `sha256:${(name === "old" ? "a" : "b").repeat(64)}`,
  imageInput: `input-${name}`,
  bootId: `boot-${name}`,
});
const old = identity("old"),
  candidate = identity("candidate"),
  key = "ab".repeat(32);
const controllerCode = globalThis.FIXTURE_CONTROLLER_CODE;

export class Controller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.streams = new SlotStreams();
    this.calls = { start: 0, install: 0, retire: 0 };
    this.closed = new Set();
    this.inTransaction = false;
    this.store = new RuntimeSlotStorage({
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      transaction: (work) =>
        ctx.storage.transaction(async (transaction) => {
          this.inTransaction = true;
          try {
            return await work(transaction);
          } finally {
            this.inTransaction = false;
          }
        }),
    });
    const health = (identity) => ({ identity, policyLeaseUntil: performance.now() + 1_500 });
    const external = () => {
      if (this.inTransaction) throw new Error("runtime I/O inside transaction");
    };
    this.driver = {
      start: async (target) => {
        external();
        this.calls.start++;
        return health({ ...target, bootId: candidate.bootId });
      },
      observe: async (target) => {
        external();
        return health({ ...target, bootId: candidate.bootId });
      },
      health: async (identity) => {
        external();
        return health(identity);
      },
      install: async (identity, policy) => {
        external();
        this.calls.install++;
        if (this.failCandidate && identity.slotId === "candidate") throw new Error("policy400");
        const prior = await ctx.storage.get(`fixture-native-policy:${identity.slotId}`);
        if (prior && prior.revision > policy.revision) throw new Error("stale policy");
        await ctx.storage.put(`fixture-native-policy:${identity.slotId}`, policy);
      },
      retire: async () => {
        external();
        this.calls.retire++;
      },
      fetch: async (identity, request) => {
        external();
        const use = await openEnvelope(
          key,
          policyUsePrefix,
          request.headers.get(policyHeader) ?? "",
        );
        const policy = await ctx.storage.get(`fixture-native-policy:${identity.slotId}`);
        if (!policy || policy.dirty || use?.revision !== policy.revision)
          return new Response(null, { status: 503 });
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(identity.bootId);
        pair[1].addEventListener("message", (event) => pair[1].send(event.data));
        pair[1].addEventListener("close", () => this.closed.add(identity.bootId));
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    };
    this.reconstruct();
    this.memberships = new NativeMemberships({
      storage: ctx.storage,
      signingKey: key,
      read: async () => {
        throw new Error("read must stay passive");
      },
      actual: async () => [],
      reconcile: async () => {},
      install: (policy) => this.slots.install(policy),
      abort: (pool) => this.slots.abortPool(pool),
      schedule: async () => {},
    });
  }
  reconstruct() {
    this.slots = new RuntimeSlots({
      controllerId: "controller",
      controllerCode,
      storage: this.store,
      streams: this.streams,
      driver: this.driver,
    });
    this.router = new RuntimeSlotRouter({
      controllerId: "controller",
      storage: this.store,
      streams: this.streams,
      driver: this.driver,
      clock: { now: Date.now, monotonic: () => performance.now() },
      defer: (work) => this.ctx.waitUntil(work),
      wrap: nativeResponse,
    });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/seed") {
        const expiresAt = Date.now() + 15_000;
        await this.ctx.storage.put(nativeMembershipKey, {
          pool: {
            pool: "pool",
            organization: "organization",
            revision: 1,
            expiresAt,
            accounts: ["account"],
            dirty: false,
            native: true,
            checkedAt: Date.now(),
            installedRevision: 1,
            installedUntil: expiresAt,
          },
        });
        await this.slots.adopt(old);
      } else if (path === "/stage-failure") {
        this.failCandidate = true;
        await this.slots.stage(candidate);
      } else if (path === "/promote" || path === "/promote-old-code") {
        this.failCandidate = false;
        const snapshot = await this.slots.inspect();
        const intent = {
          operationId: "worker-promotion",
          controllerCode: path === "/promote-old-code" ? await request.json() : controllerCode,
          expectedEpoch: 1,
          previous: old,
          candidate,
          policyDigest: snapshot.digest,
        };
        const receipts = await Promise.all([
          this.slots.promote(intent),
          this.slots.promote(intent),
        ]);
        return Response.json({ receipts, calls: this.calls });
      } else if (path === "/atomic-rollback") {
        await this.store.transact(async ({ selection }, transaction) => {
          await transaction.put(slotSelectionKey, { ...selection, epoch: 777 });
          await transaction.put("runtime-slots-v1:rollback-sentinel", true);
          throw new Error("transaction rollback witness");
        });
      } else if (path === "/reconstruct") {
        this.reconstruct();
      } else if (path === "/revoke") {
        await this.memberships.reserve(
          new Request("http://private/pool/v1/membership", {
            method: "POST",
            body: JSON.stringify({
              envelope: await signEnvelope(key, membershipPrefix, {
                pool: "pool",
                organization: "organization",
                at: Date.now(),
                expiresAt: Date.now() + 30_000,
              }),
            }),
          }),
        );
      } else if (path === "/socket") {
        return await this.router.forward("pool", request, 8317, async (signal) => {
          const policy = await this.memberships.authority("pool");
          if (!policy) throw new Error("pool authority missing");
          const headers = new Headers(request.headers);
          headers.set(
            policyHeader,
            await signEnvelope(key, policyUsePrefix, {
              pool: "pool",
              revision: policy.revision,
              expiresAt: Date.now() + 7_200_000,
            }),
          );
          return new Request(request, { signal, headers });
        });
      } else if (path !== "/inspect") return new Response(null, { status: 404 });
      return Response.json({
        snapshot: await this.slots.inspect(),
        calls: this.calls,
        closed: [...this.closed],
        rollbackSentinel:
          (await this.ctx.storage.get("runtime-slots-v1:rollback-sentinel")) ?? null,
      });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 503 });
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await env.Controller.getByName("fixture").fetch(request);
    } catch (error) {
      return Response.json({ proxyError: error.message }, { status: 503 });
    }
  },
};
