import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./native-client-fixture.ts";
import { command } from "./support.ts";
import { now, startOperation } from "./model-scale-protocol.ts";

/** Own public CLI processes, cancellation and their independent operation/resource evidence. */
export function scaleSession(directory, peer, output) {
  let shuttingDown = false;
  const observer = fileURLToPath(new URL("./model-scale-observer.mjs", import.meta.url));
  const clients = new Map(),
    receipts = new Map(),
    series = new Map();
  const allOperations = [];
  const controllers = new Set();
  let sequence = 0,
    failure,
    currentLevel = 0;
  let failProof;
  const failed = new Promise((_, reject) => {
    failProof = reject;
  });
  void failed.catch(() => undefined);
  let wakeResource;
  async function connect(name) {
    const client = await fixture({ services: peer.services });
    clients.set(name, client);
    client.remote.expireNext(7200);
    client.remote.accessLifetime(7200);
    await client.login();
    await command(["agent", "add", "both", "models"], client.home);
    const origin = await client.start(["--import", observer]);
    const token = await client.token();
    const runtime = client.runtime();
    assert.ok(runtime?.child.pid);
    const records = [];
    series.set(name, records);
    let buffer = runtime.stderr();
    const parse = () => {
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith("SCALE_RECEIPT ")) {
          const record = JSON.parse(line.slice(14));
          receipts.set(record.id, record.at);
          output("local-receipts.jsonl", { ...record, gateway: name });
        } else if (line.startsWith("SCALE_RESOURCE ")) {
          const record = {
            ...JSON.parse(line.slice(15)),
            gateway: name,
            level: currentLevel,
            upstreamActive: peer.active.get(name) ?? 0,
            upstreamPendingHeaders: [...peer.records.values()].filter(
              (record) => record.gateway === name && !record.firstSentAt && !record.endedAt,
            ).length,
          };
          assert.equal(
            record.pid,
            runtime.child.pid,
            "Telemetry must come from the actual gateway child.",
          );
          records.push(record);
          output("resources.jsonl", record);
          wakeResource?.();
        }
      }
    };
    parse();
    runtime.child.stderr.on("data", (chunk) => {
      try {
        buffer += chunk;
        parse();
      } catch (error) {
        stop(error);
      }
    });
    void runtime.exited.then((result) => {
      if (!failure && !shuttingDown) {
        writeFileSync(join(directory, `gateway-${name}-failure.log`), result.stderr);
        stop(new Error(`Gateway ${name} exited ${result.code}.`));
      }
    });
    return { origin, token };
  }
  function stop(error) {
    if (failure) return;
    failure = error;
    failProof(error);
    output("failures.jsonl", { at: now(), message: error.message, record: error.record });
    for (const controller of controllers) controller.abort();
  }
  async function operation(client, gateway, protocol, extra = {}) {
    if (failure) throw failure;
    const id = `${gateway}-${++sequence}`;
    const controller = new AbortController();
    controllers.add(controller);
    const input = {
      id,
      gateway,
      protocol,
      slow: false,
      probe: false,
      thinkingMs: 25,
      streamMs: 60_000,
      ...extra,
    };
    const request = startOperation(client.origin, client.token, input, controller.signal);
    const result = request.result
      .then((record) => {
        const upstream = peer.records.get(id);
        assert.ok(upstream, "Every success needs actual upstream receipt.");
        assert.ok(receipts.has(id), "The actual gateway must have recorded local receipt.");
        const combined = {
          ...record,
          upstream,
          localReceivedAt: receipts.get(id),
          ownCapWaitMs: 0,
          level: currentLevel,
        };
        allOperations.push(combined);
        output("operations.jsonl", combined);
        return combined;
      })
      .catch((error) => {
        if (!shuttingDown) stop(error);
        throw error;
      })
      .finally(() => controllers.delete(controller));
    void result.catch(() => undefined);
    return { connected: request.connected, result };
  }

  return {
    connect,
    operation,
    stop,
    failed,
    series,
    clients,
    allOperations,
    get failure() {
      return failure;
    },
    set level(value) {
      currentLevel = value;
    },
    resourcesReady: async () => {
      const ready = () => [...series.values()].every((value) => value.length);
      if (!ready())
        await Promise.race([
          failed,
          new Promise((resolve) => {
            wakeResource = () => {
              if (ready()) {
                wakeResource = undefined;
                resolve();
              }
            };
          }),
        ]);
    },
    close: async () => {
      shuttingDown = true;
      for (const controller of controllers) controller.abort();
      return Promise.allSettled([...clients.values()].map((client) => client.close()));
    },
  };
}
