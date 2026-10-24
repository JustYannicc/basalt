import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { credentialSecretNames, maxGitHubSecretBytes } from "./constants.ts";
import { setGitHubSecret, type GitHubSecretOptions } from "./github-secret.ts";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.kill = () => true;
  return child;
}

function spawnOverride(
  run: (command: string, args: readonly string[], options: SpawnOptions, child: FakeChild) => void,
  child = fakeChild(),
): GitHubSecretOptions["spawnProcess"] {
  return ((command: string, args: readonly string[], options: SpawnOptions) => {
    run(command, args, options, child);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
}

test("writes raw stdin with gh and gives it only the repository token and PATH", async () => {
  const child = fakeChild();
  const chunks: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on("finish", () => setImmediate(() => child.emit("close", 0, null)));
  let command = "";
  let args: readonly string[] = [];
  let environment: NodeJS.ProcessEnv = {};

  await setGitHubSecret(credentialSecretNames.claude, '{"type":"claude","access_token":"private-fixture"}', "secret-token", "owner/repository", {
    path: "/usr/bin",
    spawnProcess: spawnOverride((actualCommand, actualArgs, options) => {
      command = actualCommand;
      args = actualArgs;
      environment = options.env ?? {};
    }, child),
  });

  assert.equal(command, "gh");
  assert.deepEqual(args, ["secret", "set", credentialSecretNames.claude, "--repo", "owner/repository"]);
  assert.deepEqual(environment, { PATH: "/usr/bin", GH_TOKEN: "secret-token" });
  assert.equal(Buffer.concat(chunks).toString("utf8"), '{"type":"claude","access_token":"private-fixture"}');
});

test("rejects secret names outside the closed two-secret set before spawning gh", async () => {
  let spawned = false;
  const spawnProcess = spawnOverride(() => { spawned = true; });
  for (const name of ["PREVIEW_CODEX_CLI_AUTH_JSON", "RELEASE_UPDATE_TOKEN", "OTHER_SECRET"]) {
    await assert.rejects(
      setGitHubSecret(name, "credential-fixture", "secret-token", "owner/repository", { path: "/usr/bin", spawnProcess }),
      (error: unknown) => error instanceof Error && error.message === "Credential secret update failed.",
    );
  }
  await assert.rejects(
    setGitHubSecret(credentialSecretNames.codex, "x".repeat(maxGitHubSecretBytes + 1), "secret-token", "owner/repository", {
      path: "/usr/bin",
      spawnProcess,
    }),
    /Credential secret update failed\./,
  );
  assert.equal(spawned, false);
});

test("hides gh start errors and child error details", async () => {
  const child = fakeChild();
  const spawnProcess = spawnOverride((_command, _args, _options, spawnedChild) => {
    setImmediate(() => spawnedChild.emit("error", new Error("private URL, token, and response body")));
  }, child);
  await assert.rejects(
    setGitHubSecret(credentialSecretNames.codex, '{"type":"codex"}', "secret-token", "owner/repository", {
      path: "/usr/bin",
      spawnProcess,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Credential secret update failed.");
      assert.equal(error.message.includes("private URL"), false);
      return true;
    },
  );
});

test("kills a timed out gh process and waits for close without exposing its error", async () => {
  const child = fakeChild();
  const signals: NodeJS.Signals[] = [];
  child.kill = (signal) => {
    if (signal) signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => child.emit("close", null, signal));
    return true;
  };

  await assert.rejects(
    setGitHubSecret(credentialSecretNames.claude, '{"type":"claude"}', "secret-token", "owner/repository", {
      path: "/usr/bin",
      timeoutMs: 5,
      killGraceMs: 5,
      spawnProcess: spawnOverride(() => {}, child),
    }),
    (error: unknown) => error instanceof Error && error.message === "Credential secret update failed.",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
