import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../pool-tests/runtime-handoff-fixture.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";
import { nativeMembershipKey } from "../../src/pool/runtime-slots/storage.ts";

async function controller() {
  const f = await fleetWorkerFixture({ candidateColor: "green" });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "enable",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const policies = {
    ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      await f.old.storage.get(nativeMembershipKey),
    ),
  };
  for (const [pool, value] of Object.entries(policies))
    policies[pool] = {
      ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value),
      expiresAt: Date.now() + 240000,
    };
  await f.old.storage.put(nativeMembershipKey, policies);
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const stopped = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableEnded) stopped.abort();
    });
    const response = await f.worker.runtimeHandoff(
      new Request(`http://pool-operations${incoming.url}`, {
        method: incoming.method,
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
        signal: stopped.signal,
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    f,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.cleanup();
    },
  };
}

async function client(port: number, key: string, command: object, startup?: object) {
  const child = spawn("bun", [new URL("./test/runtime-ipc-client.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ port, key, command, startup }));
  const [exitCode] = await once(child, "exit");
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return {
    exitCode,
    value: Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Boolean,
        elapsedMs: Schema.Number,
        response: Schema.optional(Schema.Unknown),
        error: Schema.optional(Schema.Struct({ name: Schema.String, message: Schema.String })),
        bindingDestination: Schema.String,
        dispatcher: Schema.Literal("production"),
        parentRuntime: Schema.Literal("bun"),
      }),
    )(JSON.parse(text)),
  };
}

test("runtime commands cross the production Bun to Node dispatcher to the actual controller", async (context) => {
  const c = await controller();
  context.after(c.close);
  const reply = await client(c.port, c.f.old.env.POOL_DEPLOYMENT_KEY!, {
    action: "inspect",
    controllerCode: runtimeFixtureCode,
  });
  assert.equal(reply.exitCode, 0, JSON.stringify(reply.value));
  assert.equal(reply.value.ok, true);
  assert.equal(reply.value.bindingDestination, `http://127.0.0.1:${c.port}`);
});

test("stage acknowledges through the real 15 second IPC bound before a 16 second cold boot", async (context) => {
  const c = await controller();
  const boot = deferred();
  c.f.onRuntimeCreated(async (runtime) => {
    runtime.hooks.health = () => boot.promise;
  });
  const release = setTimeout(() => boot.resolve(), 16000);
  context.after(async () => {
    boot.resolve();
    clearTimeout(release);
    await c.close();
  });
  const grant = await c.f.startGrant();
  const reply = await client(c.port, c.f.old.env.POOL_DEPLOYMENT_KEY!, {
    action: "stage",
    proof: grant.envelope,
    controllerCode: runtimeFixtureCode,
  });
  assert.equal(reply.exitCode, 0, JSON.stringify(reply.value));
  assert.equal(reply.value.ok, true);
  const response = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        status: Schema.Literal("starting"),
        deadline: Schema.Number,
      }),
    }),
  )(reply.value.response);
  assert.ok(response.result.deadline > Date.now());
  assert.ok(reply.value.elapsedMs < 15000);
  assert.equal((await c.f.model()).status, 200);
  const ready = await client(
    c.port,
    c.f.old.env.POOL_DEPLOYMENT_KEY!,
    { controllerCode: runtimeFixtureCode },
    { target: grant.proof.target, operationId: grant.proof.operationId },
  );
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.value));
  assert.ok(Date.now() >= response.result.deadline - 180000 + 16000);
  const snapshot = await c.f.inspect();
  assert.deepEqual(ready.value.response, snapshot.selection?.candidate?.identity);
});
