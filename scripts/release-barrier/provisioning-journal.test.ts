import assert from "node:assert/strict";
import { test } from "node:test";
import {
  provisioningJournal,
  type ProvisioningRecord,
  type ProvisioningStore,
} from "./provisioning-journal.ts";

function memoryStore() {
  let value: ProvisioningRecord | undefined;
  let tail = Promise.resolve();
  const store: ProvisioningStore = {
    exclusive: async (work) => {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    },
    read: async () => value,
    write: async (record) => {
      value = structuredClone(record);
    },
  };
  return store;
}
const candidate = "a".repeat(40),
  manifest = "b".repeat(64),
  request = "c".repeat(64);
const parse = (value: unknown) => {
  assert.equal(value, "acknowledged-result");
  return value;
};

test("a lost response remains unknown across a restarted reader with an empty provider listing", async () => {
  const store = memoryStore();
  let creates = 0;
  const perform = async () => {
    creates++;
    throw new Error("Lost response after provider commit");
  };
  await assert.rejects(
    provisioningJournal(store, candidate, manifest).once("create", request, perform, parse),
    /provisioning-operation-unknown/,
  );
  assert.equal(creates, 1);
  const restarted = provisioningJournal(store, candidate, manifest);
  await assert.rejects(
    restarted.once(
      "create",
      request,
      async () => {
        creates++;
        return "acknowledged-result";
      },
      parse,
    ),
    /provisioning-operation-unknown/,
  );
  assert.equal(creates, 1);
  assert.equal((await restarted.read()).operations.create!.outcome, "unknown");
});

test("a crash after durable intent and before send prevents any later create", async () => {
  const store = memoryStore();
  const write = store.write;
  store.write = async (record) => {
    await write(record);
    throw new Error("Crash after pending persisted");
  };
  let creates = 0;
  const perform = async () => {
    creates++;
    return "acknowledged-result";
  };
  await assert.rejects(
    provisioningJournal(store, candidate, manifest).once("create", request, perform, parse),
    /Crash/,
  );
  store.write = write;
  await assert.rejects(
    provisioningJournal(store, candidate, manifest).once("create", request, perform, parse),
    /provisioning-operation-unknown/,
  );
  assert.equal(creates, 0);
});

test("a lost acknowledgement write never causes another dispatch", async () => {
  const store = memoryStore();
  const write = store.write;
  store.write = async (record) => {
    if (record.operations.create?.outcome === "acknowledged")
      throw new Error("Acknowledgement save failed");
    await write(record);
  };
  let creates = 0;
  const perform = async () => {
    creates++;
    return "acknowledged-result";
  };
  await assert.rejects(
    provisioningJournal(store, candidate, manifest).once("create", request, perform, parse),
    /Acknowledgement/,
  );
  store.write = write;
  await assert.rejects(
    provisioningJournal(store, candidate, manifest).once("create", request, perform, parse),
    /provisioning-operation-unknown/,
  );
  assert.equal(creates, 1);
});

test("the exclusive writer serializes concurrent attempts and reuses an acknowledged result", async () => {
  const store = memoryStore();
  let creates = 0;
  const journal = provisioningJournal(store, candidate, manifest);
  const perform = async () => {
    creates++;
    return "acknowledged-result";
  };
  assert.deepEqual(
    await Promise.all([
      journal.once("create", request, perform, parse),
      journal.once("create", request, perform, parse),
    ]),
    ["acknowledged-result", "acknowledged-result"],
  );
  assert.equal(creates, 1);
  await assert.rejects(
    journal.once("create", "d".repeat(64), perform, parse),
    /provisioning-input-drift/,
  );
  await assert.rejects(
    provisioningJournal(store, "e".repeat(40), manifest).once("create", request, perform, parse),
    /provisioning-input-drift/,
  );
  assert.equal(creates, 1);
});
