import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { prepareRecordedCandidate } from "./recorded-candidate.ts";

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "recorded-candidate-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout"),
    target = join(directory, "candidate");
  mkdirSync(join(root, "scripts/release-barrier"), { recursive: true });
  writeFileSync(join(root, "scripts/release-barrier/entry.ts"), "export const version = 1;\n");
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  git("config", "remote.origin.url", root);
  const request = {
    candidate: git("rev-parse", "HEAD"),
    sourceRun: "42/1",
    pairSha256: "b".repeat(64),
    databaseCompatible: true,
  };
  const commands: string[][] = [];
  return {
    options: {
      root,
      target,
      request,
      workflowSha: "c".repeat(40),
      prepared: false,
      run: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        mkdirSync(join(target, ".local"), { recursive: true });
        writeFileSync(join(target, ".local/built.js"), "prepared assets");
        return { started: true, exitCode: 0 };
      },
    },
    commands,
  };
}

test("the protected recovery job refuses an environment that was not prepared earlier", async (context) => {
  const { options, commands } = fixture(context);
  await assert.rejects(
    prepareRecordedCandidate({ ...options, prepared: true }),
    /prepared recovery environment/,
  );
  assert.deepEqual(commands, []);
});

test("the protected job consumes the exact earlier build without running preparation again", async (context) => {
  const { options, commands } = fixture(context);
  await prepareRecordedCandidate(options);
  assert.deepEqual(commands, [
    ["npm", "run", "prepare:upstream"],
    ["npm", "run", "build"],
  ]);
  commands.length = 0;
  assert.equal(await prepareRecordedCandidate({ ...options, prepared: true }), options.target);
  assert.equal(readFileSync(join(options.target, ".local/built.js"), "utf8"), "prepared assets");
  assert.deepEqual(commands, []);
});

for (const changed of [
  "candidate",
  "sourceRun",
  "pairSha256",
  "databaseCompatible",
  "workflowSha",
] as const)
  test(`the protected job refuses a prepared environment with changed ${changed}`, async (context) => {
    const { options, commands } = fixture(context);
    await prepareRecordedCandidate(options);
    commands.length = 0;
    const request = { ...options.request };
    if (changed === "databaseCompatible") request.databaseCompatible = false;
    else if (changed !== "workflowSha") request[changed] = "changed";
    await assert.rejects(
      prepareRecordedCandidate({
        ...options,
        request,
        prepared: true,
        workflowSha: changed === "workflowSha" ? "d".repeat(40) : options.workflowSha,
      }),
      /prepared recovery environment/,
    );
    assert.deepEqual(commands, []);
  });

test("the protected job refuses tracked source drift after the earlier build", async (context) => {
  const { options, commands } = fixture(context);
  await prepareRecordedCandidate(options);
  commands.length = 0;
  writeFileSync(
    join(options.target, "scripts/release-barrier/entry.ts"),
    "export const changed = true;\n",
  );
  await assert.rejects(prepareRecordedCandidate({ ...options, prepared: true }), /tracked source/);
  assert.deepEqual(commands, []);
});

test("the retained environment restores worktree metadata, build outputs and absolute dependency links", async (context) => {
  const { options, commands } = fixture(context);
  await prepareRecordedCandidate(options);
  const directory = join(options.root, "..");
  const cache = join(directory, "cache");
  mkdirSync(cache);
  writeFileSync(join(cache, "dependency.js"), "prepared dependency");
  symlinkSync(join(cache, "dependency.js"), join(options.target, ".local/dependency.js"));
  const archive = join(directory, "environment.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", directory, "checkout", "candidate", "cache"]);
  for (const path of [options.root, options.target, cache]) rmSync(path, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", directory]);
  commands.length = 0;
  assert.equal(await prepareRecordedCandidate({ ...options, prepared: true }), options.target);
  assert.equal(readFileSync(join(options.target, ".local/built.js"), "utf8"), "prepared assets");
  assert.equal(
    readFileSync(join(options.target, ".local/dependency.js"), "utf8"),
    "prepared dependency",
  );
  assert.deepEqual(commands, []);
});
