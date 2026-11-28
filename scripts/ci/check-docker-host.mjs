import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2];
assert.ok(
  image,
  "Usage: node scripts/ci/check-docker-host.mjs <local-image-with-python3> [probe-limit-seconds]",
);
// The first container after an image export can take tens of seconds to start on a busy runner;
// the container's own HTTP check gives up after 5 s once it runs.
const probeLimit = Number(process.argv[3] ?? 60) * 1000;
assert.ok(Number.isFinite(probeLimit) && probeLimit > 0, "The probe limit is a number of seconds");
const marker = randomUUID();
const network = `basalt-host-probe-${marker}`;
const server = createServer((_request, response) => response.end(marker));
server.listen(0, "0.0.0.0");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const url = new URL("http://host.docker.internal/");
url.port = String(address.port);
// A timed-out `docker run` is killed outright: it forwards SIGTERM to the container and keeps
// waiting, so a gentler signal lets the probe outlive its limit. `rm --force` removes the container.
const docker = (args, timeout = 15_000) =>
  execute("docker", args, { timeout, killSignal: "SIGKILL" });

/** One probe container on `bridge`; a failure says whether it ran out of time or answered badly. */
async function probe(args, bridge) {
  try {
    return (await docker(args, probeLimit)).stdout;
  } catch (error) {
    if (error?.killed)
      throw new Error(
        `The probe on ${bridge} timed out after ${probeLimit / 1000} s before the container answered; nothing says the host listener was unreachable`,
        { cause: error },
      );
    throw new Error(
      `docker run on ${bridge} exited with ${error?.code ?? error?.signal ?? "no status"} before the container answered: ${String(error?.stderr ?? "").trim() || "no output"}`,
      { cause: error },
    );
  }
}
let createdNetwork = false;
try {
  await docker(["network", "create", network]);
  createdNetwork = true;
  for (const bridge of ["bridge", network]) {
    const name = `basalt-host-probe-${randomUUID()}`;
    try {
      // Keep the event loop free so the host listener can answer the container.
      const label = bridge === "bridge" ? "docker0" : "the private Docker bridge";
      const stdout = await probe(
        [
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
        ],
        label,
      );
      assert.equal(
        stdout.trim(),
        marker,
        `The container on ${label} did not reach the host listener`,
      );
      console.log(`Container-to-host HTTP passed on ${label}`);
    } finally {
      await docker(["rm", "--force", name]).catch(() => {});
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  // A failed cleanup is reported, never in place of the probe's own failure.
  if (createdNetwork)
    await docker(["network", "rm", network]).catch((error) =>
      console.error(`Could not remove the probe network: ${String(error?.stderr ?? error).trim()}`),
    );
}
