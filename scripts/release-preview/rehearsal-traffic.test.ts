import assert from "node:assert/strict";
import { test } from "node:test";
import { holdModelSocket, modelTraffic } from "./rehearsal-traffic.ts";

const access = { computerId: "computer", modelUrl: "https://app.rehearsal-11.example.invalid", modelKey: "key" };

test("traffic counts real request outcomes until stopped", async () => {
  let calls = 0;
  const client = {
    sendTurn: async (key: string, model: string) => {
      assert.equal(key, "key");
      assert.equal(model, "model");
      calls += 1;
      if (calls === 2) throw new Error("503");
      return {};
    },
  };
  const traffic = modelTraffic(access, "model", new AbortController().signal, client, 1);
  while (calls < 4) await new Promise((resolve) => setTimeout(resolve, 2));
  const counts = await traffic.stop();
  assert.equal(counts.failed, 1);
  assert.equal(counts.ok + counts.failed, calls);
});

function fakeSocket(outcome: "open" | "error") {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const fire = (type: string) => {
    const pending = listeners.get(type) ?? [];
    listeners.set(type, []);
    for (const listener of pending) listener({});
  };
  const opened: { url?: string; headers?: Record<string, string> } = {};
  const socket = {
    readyState: 0,
    close: () => fire("close"),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  const open = (url: string, headers: Record<string, string>) => {
    Object.assign(opened, { url, headers });
    queueMicrotask(() => fire(outcome));
    return socket;
  };
  return { open, opened, fire };
}

test("a held socket upgrades the Responses route with the pool bearer and closes on request", async () => {
  const fake = fakeSocket("open");
  const held = await holdModelSocket(access, fake.open);
  assert.equal(fake.opened.url, "wss://app.rehearsal-11.example.invalid/v1/responses");
  assert.deepEqual(fake.opened.headers, { Authorization: "Bearer key" });
  await held.close();
});

test("a socket that fails to open, or that the pool closed early, fails the scenario", async () => {
  await assert.rejects(holdModelSocket(access, fakeSocket("error").open), /failed to open/);
  const fake = fakeSocket("open");
  const held = await holdModelSocket(access, fake.open);
  fake.fire("close");
  await assert.rejects(held.close(), /closed before the rehearsal released it/);
});
