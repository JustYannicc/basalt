// Regression: unknown-error-type
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { withOperation } from "./operation-failure.ts";
import { releaseEvidence } from "./evidence.ts";
import { refusalTable } from "./refusal-report.ts";

// A release refused with provider type "unknown": the native fetch error that reached the receipt
// was an HttpClientError, which the closed type list did not name.
test("a native fetch baseline failure is reported with its closed HTTP client type and reason", async (context) => {
  let received = 0;
  const server = createServer((_request, response) => {
    received++;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "unknown-error-type-"));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  // The production error object: native fetch rejects a GET that carries a body before sending it.
  const exit = await Effect.runPromiseExit(
    HttpClient.execute(
      HttpClientRequest.get(
        `http://127.0.0.1:${address.port}/accounts/fixture/workers/scripts/Api/deployments`,
      ).pipe(HttpClientRequest.bodyText("{}", "application/json")),
    ).pipe(withOperation("Api", "read-worker-baseline"), Effect.provide(FetchHttpClient.layer)),
  );
  assert.ok(Exit.isFailure(exit));
  assert.equal(received, 0);
  const directory = join(root, "release-barrier");
  const failure = await releaseEvidence(directory, "a".repeat(40)).failure(
    Cause.squash(exit.cause),
  );
  assert.equal(failure.operation, "read-worker-baseline");
  assert.equal(failure.worker, "Api");
  assert.deepEqual(failure.provider, { type: "HttpClientError", reason: "TransportError" });
  for (const output of [
    await readFile(join(directory, "failure.json"), "utf8"),
    refusalTable(failure),
  ]) {
    assert.ok(output.includes("HttpClientError"));
    assert.ok(output.includes("TransportError"));
    assert.ok(!output.includes("unknown"));
    assert.ok(!output.includes("127.0.0.1"));
  }
});
