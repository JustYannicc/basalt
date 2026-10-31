import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Own only the independent CLI processes started by this product scenario. */
export function nativeClientCli(root, home) {
  const cli = join(root, "clients/cli/main.mjs");
  let runtime;
  function launch(args) {
    const child = spawn("node", [cli, "--home", home, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
    return { child, exited, stderr: () => stderr };
  }
  async function ready(child, pattern) {
    const found = () => pattern.exec(child.stderr());
    if (found()) return found();
    return new Promise((yes, no) => {
      const data = () => {
        const result = found();
        if (result) {
          child.child.stderr.off("data", data);
          yes(result);
        }
      };
      child.child.stderr.on("data", data);
      void child.exited.then((result) => {
        child.child.stderr.off("data", data);
        no(new Error(`CLI readiness failed with exit ${result.code}`));
      });
    });
  }
  async function command(args) {
    const result = await launch(args).exited;
    assert.equal(result.code, 0, `CLI ${args[0]} succeeds`);
    return result;
  }
  async function start() {
    runtime = launch(["run"]);
    await ready(runtime, /Connection ready at /u);
    return JSON.parse(await readFile(join(home, "runtime.json"), "utf8")).origin;
  }
  async function stop() {
    if (!runtime) return;
    runtime.child.kill("SIGTERM");
    assert.equal((await runtime.exited).code, 0);
    runtime = undefined;
  }
  return { launch, ready, command, start, stop };
}
