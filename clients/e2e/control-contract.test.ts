import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { launch } from "./support.ts";

test("the operator CLI refuses a malformed private IPC response", { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "client-control-protocol-"));
  const token = randomBytes(32).toString("base64url");
  await writeFile(join(home, "operator.json"), JSON.stringify({ token }), { mode: 0o600 });
  const identity = createHash("sha256").update(home).digest("hex").slice(0, 20);
  const socket = join(
    "/tmp",
    `signalbox-client-${process.getuid?.()}-${identity}`,
    "connection.sock",
  );
  await mkdir(dirname(socket), { mode: 0o700 });
  const peer = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        state: "connected",
        mode: "direct",
        capabilities: ["administrator"],
        unexpected: "sensitive-fixture-marker",
      }),
    );
  });
  try {
    peer.listen(socket);
    await once(peer, "listening");
    const result = await launch(["status"], home).exited;
    assert.equal(result.code, 1, "Malformed status must never be accepted as connection state.");
    assert.ok(
      !result.stdout.includes("administrator") &&
        !result.stdout.includes("sensitive-fixture-marker"),
    );
    assert.ok(!result.stderr.includes("sensitive-fixture-marker"));
  } finally {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await rm(dirname(socket), { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
