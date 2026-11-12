import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ready } from "./native-client-fixture.ts";
import type { launch } from "./support.ts";

/** Hold a caller's real profile read so disconnect races have a deterministic external boundary. */
export async function profileGate(home: string) {
  const preload = join(home, "profile-gate.mjs");
  const address = join(home, "profile-gate.json");
  await writeFile(
    preload,
    `
    import files from "node:fs/promises";
    import { Server, createServer } from "node:http";
    import { AsyncLocalStorage } from "node:async_hooks";
    import { syncBuiltinESMExports } from "node:module";
    const context = new AsyncLocalStorage();
    const held = new Map();
    const emit = Server.prototype.emit;
    Server.prototype.emit = function(event, ...args) {
      if (event !== "request" && event !== "upgrade") return emit.call(this, event, ...args);
      const id = args[0].headers["x-fixture-id"];
      const target = args[1];
      target.once("close", () => process.stderr.write("CLOSED " + id + "\\n"));
      return context.run(id, () => emit.call(this, event, ...args));
    };
    const open = files.open;
    files.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("/profile.json")) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          const id = context.getStore();
          if (id) await new Promise(resolve => {
            held.set(id, resolve);
            process.stderr.write("HELD " + id + "\\n");
          });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const control = createServer((request, response) => {
      for (const release of held.values()) release();
      held.clear();
      response.end();
    });
    await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
    control.unref();
    await files.writeFile(${JSON.stringify(address)}, JSON.stringify({port: control.address().port}));
  `,
  );
  return {
    execArgv: ["--import", preload],
    held: (runtime: ReturnType<typeof launch>, id: string) =>
      ready(runtime, new RegExp(`HELD ${id}\\n`)),
    closed: (runtime: ReturnType<typeof launch>, id: string) =>
      ready(runtime, new RegExp(`CLOSED ${id}\\n`)),
    release: async () => {
      const { port } = JSON.parse(await readFile(address, "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.text();
    },
  };
}
