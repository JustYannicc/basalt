/**
 * Root writes the wire guard must refuse, from the second adversarial read of its root rule, with
 * the guard configured as the entry configures production once the root is pushed.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Effect } from "effect";
import { install, type WireGuardConfig } from "./wire-guard.ts";

const ACCOUNT = "1".repeat(32);
const ROOT = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";
const NAME = "basalt-production-poolcontainer";
const production: WireGuardConfig = {
  rootApplications: [ROOT],
  rootApplicationNames: [NAME],
  rootRequired: true,
};
const stale: WireGuardConfig = {
  rootApplications: ["33333333-3333-4333-8333-333333333333"],
  rootApplicationNames: [NAME],
  rootRequired: true,
};
const envelope = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], messages: [], result });
const api = `/client/v4/accounts/${ACCOUNT}`;

type Answer = (method: string, path: string) => { status?: number; body?: string } | undefined;
const serve = async (t: TestContext, answer: Answer = () => undefined) => {
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    received.push(`${req.method} ${req.url}`);
    const a = answer(req.method ?? "", req.url ?? "");
    res.statusCode = a?.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(a?.body ?? envelope({ id: LIVE, name: NAME }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received };
};
const send = (config: WireGuardConfig, steps: Array<[string, string]>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install(config);
        for (const [method, url] of steps)
          yield* Effect.promise(() =>
            guard.fetch(url, { method }).then(
              () => undefined,
              () => undefined,
            ),
          );
      }),
    ),
  );
const writes = (received: string[]) => received.filter((line) => !/^(GET|HEAD) /.test(line));

test("the containers API's cloudchamber path to the root is refused like the containers path", async (t) => {
  const s = await serve(t);
  await send(production, [
    ["PATCH", `${s.base}${api}/cloudchamber/applications/${ROOT}`],
    ["POST", `${s.base}${api}/cloudchamber/applications/${ROOT}/rollouts`],
    ["DELETE", `${s.base}${api}/cloudchamber/applications/${ROOT}`],
  ]);
  assert.deepEqual(writes(s.received), []);
});

test("an application read through the cloudchamber path holds the root it names", async (t) => {
  const s = await serve(t, (m) =>
    m === "GET" ? { body: envelope([{ id: LIVE, name: NAME }]) } : undefined,
  );
  await send(stale, [
    ["GET", `${s.base}${api}/cloudchamber/applications`],
    ["PATCH", `${s.base}${api}/containers/applications/${LIVE}`],
  ]);
  assert.deepEqual(writes(s.received), []);
});

test("the delete check refuses an application whose read names the root, attached or not", async (t) => {
  const s = await serve(t, (m, p) =>
    m === "GET" && p.endsWith(LIVE)
      ? {
          body: envelope({
            id: LIVE,
            name: NAME,
            durable_objects: null,
            health: { instances: { active: 0 } },
          }),
        }
      : undefined,
  );
  await send(stale, [["DELETE", `${s.base}${api}/containers/applications/${LIVE}`]]);
  assert.deepEqual(writes(s.received), []);
});

test("a registry write to the registry host spelled with a trailing dot is refused", async () => {
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input as RequestInfo, init);
    sent.push(`${r.method} ${r.url}`);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await send(production, [
      ["PUT", `https://registry.cloudflare.com./v2/${ACCOUNT}/${NAME}/manifests/latest`],
      [
        "DELETE",
        `https://registry.cloudflare.com./v2/${ACCOUNT}/${NAME}/manifests/sha256:${"e".repeat(64)}`,
      ],
    ]);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent, []);
});

test("a create answered with the root's name holds it whatever the collection's spelling or status", async (t) => {
  for (const [label, path, status] of [
    ["trailing slash", `${api}/containers/applications/`, 200],
    ["409 answer naming the root", `${api}/containers/applications`, 409],
  ] as const) {
    const s = await serve(t, (m) =>
      m === "POST" ? { status, body: envelope({ id: LIVE, name: NAME }) } : undefined,
    );
    await send(stale, [
      ["POST", `${s.base}${path}`],
      ["PATCH", `${s.base}${api}/containers/applications/${LIVE}`],
    ]);
    assert.ok(
      !writes(s.received).some((line) => line.startsWith("PATCH")),
      `${label}: ${s.received.join(" ; ")}`,
    );
  }
});
