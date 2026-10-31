import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

export const main = fileURLToPath(new URL("../cli/main.mjs", import.meta.url));
export const root = dirname(dirname(main));
export function launch(args: readonly string[], home: string) {
  const child = spawn(process.execPath, [main, "--home", home, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
  return { child, exited, stderr: () => stderr };
}
export async function command(args: readonly string[], home: string) {
  const result = await launch(args, home).exited;
  if (result.code !== 0) throw new Error(`CLI ${args[0]} exited ${result.code}: ${result.stderr}`);
  return result;
}

export async function fixtureHome(origin: string) {
  const home = await mkdtemp(join(tmpdir(), "signalbox-client-test-"));
  const input = join(home, "input.json");
  await writeFile(
    input,
    JSON.stringify({
      version: 1,
      mode: "direct",
      models: { origin, token: "synthetic-model-key" },
      tools: { origin, path: "/mcp", token: "ext_synthetic-tools-key" },
    }),
    { mode: 0o600 },
  );
  await command(["import-direct", input, "--storage", "file"], home);
  for (const [id, permissions] of [
    ["both", ["models", "tools"]],
    ["models", ["models"]],
    ["tools", ["tools"]],
  ] as const)
    await command(["agent", "add", id, ...permissions], home);
  const secret = async (id: string): Promise<string> =>
    JSON.parse(await readFile(join(home, `agent-${id}.json`), "utf8")).token;
  const start = async () => {
    const runtime = launch(["run"], home);
    const ready = () =>
      /Connection ready at http:\/\/127\.0\.0\.1:\d+\./u.exec(runtime.stderr())?.[0];
    if (!ready())
      await new Promise<void>((resolve, reject) => {
        const data = () => {
          if (ready()) {
            runtime.child.stderr.off("data", data);
            resolve();
          }
        };
        runtime.child.stderr.on("data", data);
        void runtime.exited.then((result) =>
          reject(new Error(`Connection exited before ready: ${result.stderr}`)),
        );
      });
    const status: { origin: string } = JSON.parse(
      await readFile(join(home, "runtime.json"), "utf8"),
    );
    return {
      ...runtime,
      origin: status.origin,
      stop: async () => {
        runtime.child.kill("SIGTERM");
        const result = await runtime.exited;
        if (result.code !== 0) throw new Error(`Connection shutdown failed: ${result.stderr}`);
      },
    };
  };
  return { home, secret, start, remove: () => rm(home, { recursive: true, force: true }) };
}

/** The caller is another Node process, with no imports from the connection implementation. */
export function independentAgent(code: string, origin: string, token: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, LOCAL_ORIGIN: origin, LOCAL_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  if (!child.stderr) throw new Error("The independent agent has no error pipe.");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "close").then(([code]) => ({ code, stderr }));
  const message = () => once(child, "message").then(([value]) => value);
  return { child, exited, message };
}

export function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
