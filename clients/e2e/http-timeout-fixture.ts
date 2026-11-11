import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Advance socket inactivity at the HTTP boundary without waiting for provider deadlines. */
export async function httpTimeoutClock(home: string) {
  const preload = join(home, "http-timeout-clock.mjs");
  const address = join(home, "http-timeout-clock.json");
  await writeFile(
    preload,
    `
    import { ClientRequest, createServer } from "node:http";
    import { writeFile } from "node:fs/promises";
    let now = 0;
    const pending = new Map();
    ClientRequest.prototype.setTimeout = function (milliseconds, callback) {
      if (milliseconds === 0) pending.delete(this);
      else {
        pending.set(this, { at: now + milliseconds, callback });
        this.once("close", () => pending.delete(this));
      }
      return this;
    };
    const control = createServer((request, response) => {
      now += Number(new URL(request.url, "http://localhost").searchParams.get("advance"));
      for (const [request, timer] of pending) {
        if (timer.at <= now) {
          pending.delete(request);
          timer.callback?.call(request);
        }
      }
      response.setHeader("Connection", "close");
      response.end();
    });
    await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
    control.unref();
    await writeFile(${JSON.stringify(address)}, JSON.stringify({ port: control.address().port }));
  `,
  );
  return {
    execArgv: ["--import", preload],
    advance: async (milliseconds: number) => {
      const { port } = JSON.parse(await readFile(address, "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/?advance=${milliseconds}`);
      await response.text();
    },
  };
}
