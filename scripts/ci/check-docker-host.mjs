import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2];
assert.ok(image, "Usage: node scripts/ci/check-docker-host.mjs <local-image-with-python3>");
const marker = randomUUID();
const network = `basalt-host-probe-${marker}`;
const server = createServer((_request, response) => response.end(marker));
server.listen(0, "0.0.0.0");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const url = new URL("http://host.docker.internal/");
url.port = String(address.port);
const docker = (args) => execute("docker", args, { timeout: 15_000 });
let createdNetwork = false;
try {
  await docker(["network", "create", network]);
  createdNetwork = true;
  for (const bridge of ["bridge", network]) {
    const name = `basalt-host-probe-${randomUUID()}`;
    try {
      // Keep the event loop free so the host listener can answer the container.
      const { stdout } = await docker([
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network",
        bridge,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--entrypoint",
        "python3",
        image,
        "-c",
        "import sys,urllib.request; r=urllib.request.build_opener(urllib.request.ProxyHandler({})).open(sys.argv[1],timeout=5); assert r.status==200; print(r.read().decode())",
        url.href,
      ]);
      assert.equal(stdout.trim(), marker, `Container on ${bridge} did not reach the host listener`);
      console.log(
        `Container-to-host HTTP passed on ${bridge === "bridge" ? "docker0" : "private Docker bridge"}`,
      );
    } finally {
      await docker(["rm", "--force", name]).catch(() => {});
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (createdNetwork) await docker(["network", "rm", network]);
}
