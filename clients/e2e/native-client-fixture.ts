import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "./support.ts";
import { nativeFixture } from "./native-fixture.ts";
export async function fixture(options?: {
  storage?: "os" | "file";
  services?: Parameters<typeof nativeFixture>[0];
  tunnel?: Parameters<typeof nativeFixture>[1];
}) {
  const storage = options?.storage ?? "file";
  if (storage === "file")
    assert.equal(process.platform, "linux", "Explicit file storage is a headless Linux choice.");
  const remote = await nativeFixture(options?.services, options?.tunnel);
  const home = await mkdtemp(join(tmpdir(), "client-native-"));
  let runtime: ReturnType<typeof launch> | undefined;
  const stop = async () => {
    if (runtime) {
      runtime.child.kill("SIGTERM");
      const result = await runtime.exited;
      runtime = undefined;
      assert.equal(result.code, 0);
    }
  };
  const start = async (execArgv: readonly string[] = []) => {
    runtime = launch(["run"], home, execArgv);
    await ready(runtime, /Connection ready at /u);
    return JSON.parse(await readFile(join(home, "runtime.json"), "utf8")).origin as string;
  };
  return {
    remote,
    home,
    runtime: () => runtime,
    start,
    stop,
    login: async () => {
      const child = launch(["login", remote.origin, "--no-browser", "--storage", storage], home);
      await ready(child, /Confirmation code: BCDF-GHJK/u);
      remote.approve();
      const result = await child.exited;
      assert.equal(result.code, 0, result.stderr);
      assert.ok(
        !result.stderr.includes("synthetic-access") && !result.stdout.includes("synthetic-refresh"),
      );
    },
    token: async () =>
      JSON.parse(await readFile(join(home, "agent-both.json"), "utf8")).token as string,
    close: async () => {
      const failures = [];
      for (const cleanup of [
        stop,
        async () => {
          if (storage === "os") await launch(["sign-out"], home).exited;
        },
        () => remote.close(),
        () => rm(home, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Native fixture cleanup failed.");
    },
  };
}
export async function ready(child: ReturnType<typeof launch>, pattern: RegExp) {
  if (pattern.test(child.stderr())) return;
  await new Promise<void>((resolve, reject) => {
    const data = () => {
      if (pattern.test(child.stderr())) {
        child.child.stderr.off("data", data);
        resolve();
      }
    };
    child.child.stderr.on("data", data);
    void child.exited.then((result) => {
      child.child.stderr.off("data", data);
      reject(new Error(`Client exited before ready: ${result.stderr}`));
    });
  });
}
