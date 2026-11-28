import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { cloudPoolGateway } from "../../.upstream/e2e/support/cloud-pool-gateway.ts";

/**
 * The local stack's front listener closes every connection spliced to an upstream when a test
 * moves it to another Cloud. This API stand-in closes, without answering, each connection that
 * `closes` picks, so whether a request is answered depends only on the connection it came on.
 */
const apiStandIn = async (closes: (socket: Socket) => boolean) => {
  const server = createServer((incoming, outgoing) => {
    if (closes(incoming.socket)) {
      incoming.socket.destroy();
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * Send `count` API requests one after another through a fresh gateway to `api`, and read the
 * forwarding-error records the gateway kept once it has closed.
 */
const throughGateway = async (api: URL, count: number) => {
  const directory = await mkdtemp(join(tmpdir(), "pool-gateway-forwarding-"));
  const previous = process.cwd();
  try {
    // The gateway reads its provider catalogs relative to the upstream tree.
    process.chdir(fileURLToPath(new URL("../../.upstream/", import.meta.url)));
    const answers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* cloudPoolGateway(api.origin, directory, api);
          const http = yield* HttpClient.HttpClient;
          const answers: Array<{ status: number; body: string }> = [];
          for (let sent = 0; sent < count; sent++) {
            const response = yield* http.execute(
              HttpClientRequest.post(new URL("/api/internal/production-ops", gateway)),
            );
            answers.push({ status: response.status, body: yield* response.text });
          }
          return answers;
        }),
      ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    );
    const log = join(directory, "cloud-forwarding-errors.ndjson");
    const records = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { answers, records };
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
};

test("independent API requests through the pool gateway never inherit a connection the front closed", async () => {
  const seen = new WeakSet<Socket>();
  await using api = await apiStandIn((socket) => seen.has(socket) || (seen.add(socket), false));
  const ok = { status: 200, body: '{"ok":true}' };
  const { answers, records } = await throughGateway(api.url, 3);
  assert.deepEqual(answers, [ok, ok, ok]);
  assert.deepEqual(records, []);
});

test("a request the gateway cannot forward is recorded with its time, service and transport code", async () => {
  await using api = await apiStandIn(() => true);
  const before = Date.now();
  const { answers, records } = await throughGateway(api.url, 1);
  const after = Date.now();
  assert.deepEqual(answers, [{ status: 502, body: "" }]);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record?.phase, "request-error");
  assert.equal(record?.service, "api");
  assert.equal(record?.reusedSocket, false);
  assert.equal(record?.code, "ECONNRESET");
  const at = Date.parse(String(record?.at));
  assert.ok(
    at >= before && at <= after,
    `the record's time ${String(record?.at)} is the failure's`,
  );
});
