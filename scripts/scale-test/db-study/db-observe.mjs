import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const id = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(id || "")) throw Error("Expected one exact owned database container ID");
const stats = () =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/var/run/docker.sock",
        path: `/containers/${id}/stats?stream=false&one-shot=true`,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("Database stats HTTP " + res.statusCode);
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(Error("Database stats timeout")));
    req.on("error", reject);
    req.end();
  });
for (;;) {
  const began = Date.now();
  try {
    const row = await stats();
    console.log(
      JSON.stringify({
        at: Date.now(),
        monotonic: performance.now() / 1000,
        cpu: row.cpu_stats,
        memory: row.memory_stats,
        networks: row.networks,
        blockIO: row.blkio_stats,
        pids: row.pids_stats,
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ at: Date.now(), error: error.message }));
    process.exitCode = 1;
    break;
  }
  await delay(Math.max(1, 1000 - (Date.now() - began)));
}
