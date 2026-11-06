import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PoolAccountRemovals } from "../../src/pool/account-removals.ts";
import { readNativeMembership } from "../../src/pool/membership-read.ts";
import { installNativePolicy } from "../../src/pool/native-policy-install.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { HomeMembership } from "../../src/pool/home-membership.ts";
import { HomeTransportFailure } from "../../src/pool/json.ts";
import {
  handleRemovalIntent,
  removalIntentPath,
  removalIntentPrefix,
} from "../../src/pool/removal-intent.ts";
import { signEnvelope } from "../../src/pool/token.ts";

/** Exercise the receiver over HTTP, with failures at its external dependency boundaries. */
export async function removalIntentErrors(checked) {
  const key = "ab".repeat(32);
  const now = Date.UTC(2026, 10, 6);
  let failure;
  let writes = 0;
  const stored = new Map();
  const history = new PoolAccountRemovals({
    async get(name) {
      if (failure === "storage-read") throw Error("synthetic storage read failure");
      return structuredClone(stored.get(name));
    },
    async put(name, value) {
      if (failure === "storage-write") throw Error("synthetic storage write failure");
      writes++;
      stored.set(name, structuredClone(value));
    },
  });
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    try {
      const response = await handleRemovalIntent(
        new Request(new URL(incoming.url, "http://127.0.0.1"), {
          method: incoming.method,
          body: Buffer.concat(chunks),
        }),
        {
          signingKey: failure === "configuration" ? "invalid-key" : key,
          now: () => now,
          refresh: async () => {
            if (failure === "membership") throw new HomeTransportFailure("transport");
            if (failure === "timeout") throw new HomeTransportFailure("timeout");
            if (failure === "defect") throw new TypeError("synthetic programming defect");
            const rejected = () =>
              new Response(
                new ReadableStream({
                  cancel: async () => {
                    throw Error("synthetic cancellation failure");
                  },
                }),
                { status: 503 },
              );
            if (failure === "membership-cancellation")
              await readNativeMembership(
                { fetch: async () => rejected() },
                key,
                "pool",
                "organization",
                now,
              );
            if (failure === "policy-cancellation")
              await installNativePolicy(
                { getTcpPort: () => ({ fetch: async () => rejected() }) },
                { signingKey: key, managementKey: "synthetic-management-key" },
                {
                  pool: "pool",
                  organization: "organization",
                  revision: 1,
                  expiresAt: now + 15_000,
                  accounts: [],
                  dirty: false,
                },
              );
            if (failure === "home-cancellation" || failure === "home-create-cancellation") {
              const client = new HomeClient(async (path, init) => {
                const route = new URL(path, "http://synthetic-home.test").pathname.replace(
                  "/v8/management",
                  "",
                );
                if (init?.method === "DELETE" || init?.method === "POST") return rejected();
                if (route === "/channel-groups")
                  return Response.json({
                    channel_groups:
                      failure === "home-cancellation"
                        ? [{ id: 1, channel_name: "signalbox-pool-pool" }]
                        : [],
                  });
                return Response.json({
                  channel_group_details: [{ id: 2, channel_group_id: 1, auth_id: "account" }],
                });
              });
              await new HomeMembership(client).reconcile(
                "pool",
                failure === "home-cancellation" ? [] : ["remaining"],
              );
            }
          },
          selected: async () => [],
          record: (...args) =>
            history.recordMany(args[0], args[1], args[2], new Date(now), args[3], args[4]),
        },
      );
      outgoing
        .writeHead(response.status, Object.fromEntries(response.headers))
        .end(await response.text());
    } catch {
      // The platform owns unexpected failures; the receiver must let them reach it.
      outgoing.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = new URL("http://127.0.0.1");
  origin.port = String(server.address().port);
  const envelope = await signEnvelope(key, removalIntentPrefix, {
    audience: removalIntentPath,
    pool: "pool",
    actor: "person",
    reference: "account",
    operation: "operation",
    at: now,
    expiresAt: now + 30_000,
  });
  const failures = [];
  try {
    for (const [name, body, fault, status] of [
      ["malformed JSON", "{", undefined, 400],
      [
        "invalid signature",
        JSON.stringify({ envelope: envelope.slice(0, -4) + "AAAA" }),
        undefined,
        401,
      ],
      ["signing configuration", JSON.stringify({ envelope }), "configuration", 503],
      ["membership transport", JSON.stringify({ envelope }), "membership", 503],
      ["membership timeout", JSON.stringify({ envelope }), "timeout", 503],
      ["membership cancellation", JSON.stringify({ envelope }), "membership-cancellation", 503],
      ["policy cancellation", JSON.stringify({ envelope }), "policy-cancellation", 503],
      ["Home removal cancellation", JSON.stringify({ envelope }), "home-cancellation", 503],
      ["Home creation cancellation", JSON.stringify({ envelope }), "home-create-cancellation", 503],
      ["receipt storage read", JSON.stringify({ envelope }), "storage-read", 503],
      ["receipt storage write", JSON.stringify({ envelope }), "storage-write", 503],
      ["unexpected defect", JSON.stringify({ envelope }), "defect", 500],
    ]) {
      failure = fault;
      const response = await fetch(new URL(removalIntentPath, origin), { method: "POST", body });
      try {
        checked(`${name} has the correct HTTP refusal`, response.status, status);
        checked(`${name} writes no receipt`, writes, 0);
        const reply = await response.text();
        checked(`${name} exposes no dependency cause`, /synthetic|invalid-key/.test(reply), false);
        if (status === 503)
          checked(`${name} retains the dependency response`, JSON.parse(reply), {
            error: "removal_intent_unavailable",
          });
      } catch (error) {
        failures.push(error);
      }
    }
    failure = undefined;
    const response = await fetch(new URL(removalIntentPath, origin), {
      method: "POST",
      body: JSON.stringify({ envelope }),
    });
    checked("receiver recovers and persists one intentional removal", response.status, 204);
    checked("failed attempts did not persist a receipt", writes, 1);
    assert.equal(failures.length, 0, failures.map((error) => error.message).join("\n"));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
