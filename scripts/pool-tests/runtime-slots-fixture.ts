import assert from "node:assert/strict";
import { RuntimeSlots } from "../../src/pool/runtime-slots/controller.ts";
import { RuntimeSlotRouter } from "../../src/pool/runtime-slots/router.ts";
import { RuntimeSlotStorage, nativeMembershipKey } from "../../src/pool/runtime-slots/storage.ts";
import { SlotStreams } from "../../src/pool/runtime-slots/streams.ts";
import {
  SlotRefused,
  sameIdentity,
  type SlotDriver,
  type SlotIdentity,
  type SlotTarget,
  type ControllerCode,
} from "../../src/pool/runtime-slots/contract.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";
import {
  membershipPrefix,
  policyHeader,
  policyUsePrefix,
  type NativeMembershipPolicy,
} from "../../src/pool/membership-contract.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";
import type { NativeStreamLease } from "../../src/pool/native-streams.ts";

const relayPath = "../../src/pool/native-response.worker.ts";
const { nativeResponse } = (await import(relayPath)) as {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
};
export { deferred, SlotMemory } from "./runtime-slot-storage.ts";
import { SlotMemory } from "./runtime-slot-storage.ts";

export const slotIdentity = (name: string): SlotIdentity => ({
  format: "pool-runtime-slot-v1",
  controllerId: "stable-controller",
  slotId: name,
  applicationId: `application-${name}`,
  applicationVersion: "1",
  instanceId: `runtime-${name}`,
  imageDigest: `sha256:${(name === "old" ? "a" : "b").repeat(64)}`,
  imageInput: `image-input-${name}`,
  bootId: `boot-${name}`,
});

export async function slotFixture() {
  let controllerCode: ControllerCode = { candidate: "a".repeat(40), workerInput: "1".repeat(64) };
  const memory = new SlotMemory(),
    storage = new RuntimeSlotStorage(memory),
    streams = new SlotStreams();
  const old = slotIdentity("old"),
    candidate = slotIdentity("candidate"),
    secret = "ab".repeat(32);
  const now = Date.now();
  const policy: NativeMembershipPolicy = {
    pool: "pool",
    organization: "organization",
    revision: 1,
    accounts: ["account"],
    dirty: false,
    expiresAt: now + 15_000,
  };
  await memory.put(nativeMembershipKey, {
    pool: {
      ...policy,
      native: true,
      checkedAt: now,
      installedRevision: 1,
      installedUntil: policy.expiresAt,
    },
  });
  const policies = new Map<string, Map<string, NativeMembershipPolicy>>();
  const runtimes = new Map([
    [old.instanceId, old],
    [candidate.instanceId, candidate],
  ]);
  const calls = {
    start: [] as SlotTarget[],
    install: [] as SlotIdentity[],
    retire: [] as SlotIdentity[],
    fetch: [] as SlotIdentity[],
  };
  const streamsClosed: string[] = [];
  const channels: { boot: string; controller: ReadableStreamDefaultController<Uint8Array> }[] = [];
  const hooks = {
    start: async (_target: SlotTarget) => {},
    install: async (_identity: SlotIdentity, _policy: NativeMembershipPolicy) => {},
    health: async (_identity: SlotIdentity) => {},
    retire: async (_identity: SlotIdentity) => {},
    authorize: async () => {},
  };
  const health = (identity: SlotIdentity) => ({
    identity,
    policyLeaseUntil: performance.now() + 1_500,
  });
  const driver: SlotDriver = {
    start: async (target) => {
      calls.start.push(target);
      await hooks.start(target);
      return health(runtimes.get(target.instanceId)!);
    },
    observe: async (target) => health(runtimes.get(target.instanceId)!),
    health: async (identity) => {
      await hooks.health(identity);
      const current = runtimes.get(identity.instanceId);
      assert.ok(current && sameIdentity(current, identity), "bound runtime boot must match");
      return health(current);
    },
    install: async (identity, policy) => {
      calls.install.push(identity);
      await hooks.install(identity, policy);
      assert.ok(sameIdentity(runtimes.get(identity.instanceId), identity));
      let installed = policies.get(identity.instanceId);
      if (!installed) {
        installed = new Map();
        policies.set(identity.instanceId, installed);
      }
      const prior = installed.get(policy.pool);
      if (
        prior &&
        (prior.revision > policy.revision ||
          (prior.revision === policy.revision &&
            (prior.dirty !== policy.dirty ||
              prior.organization !== policy.organization ||
              JSON.stringify(prior.accounts) !== JSON.stringify(policy.accounts))))
      )
        throw new SlotRefused("policy");
      installed.set(policy.pool, structuredClone(policy));
    },
    fetch: async (identity, request) => {
      calls.fetch.push(identity);
      assert.equal(await request.clone().text(), "fixture request");
      assert.ok(sameIdentity(runtimes.get(identity.instanceId), identity));
      const assertion = await openEnvelope(
        secret,
        policyUsePrefix,
        request.headers.get(policyHeader) ?? "",
      );
      const installed = policies.get(identity.instanceId)?.get("pool");
      assert.ok(
        assertion &&
          typeof assertion === "object" &&
          "revision" in assertion &&
          installed &&
          !installed.dirty &&
          assertion.revision === installed.revision,
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            channels.push({ boot: identity.bootId, controller });
            controller.enqueue(new TextEncoder().encode(`${identity.bootId}\n`));
            request.signal.addEventListener(
              "abort",
              () => {
                streamsClosed.push(identity.bootId);
                try {
                  controller.error(new Error("runtime request aborted"));
                } catch {}
              },
              { once: true },
            );
          },
        }),
      );
    },
    drain: async () => ({ active: 0, known: true }),
    retire: async (_target, identity) => {
      calls.retire.push(identity);
      await hooks.retire(identity);
      assert.ok(sameIdentity(runtimes.get(identity.instanceId), identity));
      runtimes.delete(identity.instanceId);
    },
  };
  const background: Promise<void>[] = [];
  const controller = () =>
    new RuntimeSlots({ controllerId: old.controllerId, controllerCode, storage, streams, driver });
  let slots = controller();
  const memberships = new NativeMemberships({
    storage: memory,
    signingKey: secret,
    read: async (pool, organization) => ({
      pool,
      organization,
      native: true,
      accounts: [
        {
          account: "saved-account",
          requirement: "model",
          provider: "openai",
          method: "secret",
          generation: 1,
          driver: "home",
          driverRevision: "1",
          bindingRevision: "1",
          homeReference: "account",
        },
      ],
    }),
    actual: async () => ["account"],
    reconcile: async () => {},
    install: (policy) => slots.install(policy),
    abort: (pool) => slots.abortPool(pool),
    schedule: async () => {},
  });
  const makeRouter = () =>
    new RuntimeSlotRouter({
      controllerId: old.controllerId,
      storage,
      streams,
      driver,
      clock: { now: Date.now, monotonic: () => performance.now() },
      defer: (work) => {
        background.push(work);
      },
      wrap: nativeResponse,
    });
  let router = makeRouter();
  await slots.adopt(old);
  const request = () =>
    new Request("http://private/v1/responses", { method: "POST", body: "fixture request" });
  const forward = (authorize?: (signal: AbortSignal) => Promise<Request>) => {
    const input = request();
    return router.forward(
      "pool",
      input,
      8317,
      authorize ??
        (async (signal) => {
          const current = await memberships.authority("pool");
          assert.ok(current);
          await hooks.authorize();
          return new Request(input, {
            signal,
            headers: {
              [policyHeader]: await signEnvelope(secret, policyUsePrefix, {
                pool: "pool",
                revision: current.revision,
                expiresAt: Date.now() + 7_200_000,
              }),
            },
          });
        }),
    );
  };
  const reserve = async () =>
    memberships.reserve(
      new Request("http://private/pool/v1/membership", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(secret, membershipPrefix, {
            pool: "pool",
            organization: "organization",
            at: Date.now(),
            expiresAt: Date.now() + 30_000,
          }),
        }),
      }),
    );
  const intent = async () => ({
    operationId: crypto.randomUUID(),
    controllerCode,
    expectedEpoch: (await storage.inspect()).selection!.epoch,
    previous: old,
    candidate,
    policyDigest: (await storage.inspect()).digest,
  });
  return {
    memory,
    storage,
    streams,
    driver,
    old,
    candidate,
    calls,
    hooks,
    policies,
    runtimes,
    slots,
    memberships,
    forward,
    reserve,
    intent,
    background,
    streamsClosed,
    get controllerCode() {
      return controllerCode;
    },
    emit: (boot: string, text: string) => {
      for (const channel of channels.filter((channel) => channel.boot === boot)) {
        try {
          channel.controller.enqueue(new TextEncoder().encode(text));
        } catch {}
      }
    },
    reconstruct: (code = controllerCode) => {
      controllerCode = code;
      slots = controller();
      router = makeRouter();
      return slots;
    },
    cleanup: async () => {
      slots.abortPool("pool");
      await Promise.all(background);
    },
  };
}
