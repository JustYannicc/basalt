import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Advance a named transport timer only after the external peer observes the operation. */
export async function timerClock(home: string, duration: number) {
  const preload = join(home, "timer-clock.mjs");
  const address = join(home, "timer-clock.json");
  await writeFile(
    preload,
    `
    import { createServer } from "node:http";
    import { writeFile } from "node:fs/promises";
    const timeout = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const pending = new Map();
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      if (milliseconds !== ${duration}) return timeout(callback, milliseconds, ...args);
      const handle = timeout(() => {pending.delete(handle); callback(...args);}, milliseconds);
      pending.set(handle, () => callback(...args));
      return handle;
    };
    globalThis.clearTimeout = handle => {pending.delete(handle); return clear(handle);};
    const control = createServer((request, response) => {
      for (const [handle, callback] of [...pending]) {
        pending.delete(handle); clear(handle); callback();
      }
      response.end();
    });
    await new Promise(resolve => control.listen(0,"127.0.0.1",resolve));
    control.unref();
    await writeFile(${JSON.stringify(address)},JSON.stringify({port:control.address().port}));
  `,
  );
  return {
    execArgv: ["--import", preload],
    advance: async () => {
      const { port } = JSON.parse(await readFile(address, "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.text();
    },
  };
}
