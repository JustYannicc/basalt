import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const upstream = fileURLToPath(new URL("../.upstream/", import.meta.url));
const steps = {
  "apps:build": "packages/apps/dist/index.js",
  "telemetry:build": "packages/telemetry/dist/motel/index.js",
  "e2e:runtime": ".local/test-runtime/host.json",
  "e2e:apps": ".local/test-runtime/apps.tgz",
  "hosted:self-host:web:build": "apps/hosted/self-host/web/dist/index.html",
  "web:build": "apps/local/web/dist/index.html",
  "e2e:npm": ".local/test-runtime/npm/package.tgz",
};

function fixture(
  run: (
    root: string,
    command: (script: string, ci?: boolean, failedStep?: string) => SpawnSyncReturns<string>,
  ) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "basalt-web-freshness-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const packages: Record<string, string[]> = {
    "packages/apps": [],
    "packages/sdk": ["apps"],
    "packages/ui": [],
    "packages/telemetry": [],
    "apps/local/web": ["ui"],
    "apps/hosted/self-host/web": ["ui"],
  };
  for (const [path, dependencies] of Object.entries(packages)) {
    const name =
      path === "packages/apps" ? "apps" : path === "packages/ui" ? "ui" : path.replaceAll("/", "-");
    write(
      `${path}/package.json`,
      JSON.stringify({
        name,
        dependencies: Object.fromEntries(dependencies.map((name) => [name, "workspace:*"])),
      }),
    );
    write(`${path}/index.ts`, "export const value = 1;\n");
  }
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      workspaces: ["packages/*", "apps/local/web", "apps/hosted/self-host/web"],
      scripts: Object.fromEntries(
        Object.entries(steps).map(([step, output]) => [step, `node build.mjs ${step} ${output}`]),
      ),
    }),
  );
  write(
    "build.mjs",
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [step, output] = process.argv.slice(2);
if (process.env.FAKE_FAIL === step) process.exit(3);
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, step);
if (step === 'e2e:runtime') writeFileSync(output + '.map', '{}');
if (step === 'hosted:self-host:web:build') writeFileSync('apps/hosted/self-host/web/routeTree.gen.ts', 'generated route source');
appendFileSync('built.log', step + '\\n');
`,
  );
  for (const path of [
    "bun.lock",
    "tsconfig.json",
    "e2e/npm-packages.json",
    "packages/telemetry/motel/source.json",
  ])
    write(path, "{}\n");
  write(".gitignore", "dist/\n.local/\nbuilt.log\ncache/\n");
  write("apps/hosted/self-host/package.json", JSON.stringify({ type: "module" }));
  for (const path of [
    "patches/fake.patch",
    "playground/demo-apps/live-inbox/index.ts",
    "scripts/build-test-runtime.ts",
    "scripts/pack-test-apps.ts",
    "scripts/e2e-npm-packages.ts",
  ])
    write(path, "\n");
  for (const name of ["e2e-prepare.ts", "e2e-check-web.ts"]) {
    const source = join(upstream, "scripts", name);
    if (existsSync(source)) cpSync(source, join(root, "scripts", name));
  }
  const environment = { PATH: process.env.PATH, EXECUTOR_E2E_CACHE: join(root, "cache") };
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=CI fixture",
    "-c",
    "user.email=ci@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
  ]);
  const command = (script: string, ci = false, failedStep?: string) =>
    spawnSync(
      process.execPath,
      script === "suite"
        ? [
            join(upstream, "e2e/run.ts"),
            "--target",
            "self-host",
            "--test-name",
            "^No synthetic scenarios have this name$",
          ]
        : [`scripts/${script}.ts`],
      {
        cwd: root,
        env: {
          ...environment,
          CI: ci ? "true" : "",
          ...(failedStep ? { FAKE_FAIL: failedStep } : {}),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  try {
    run(root, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const output = (result: SpawnSyncReturns<string>) =>
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const prepare = (command: Parameters<Parameters<typeof fixture>[0]>[1], ci = false) => {
  const result = command("e2e-prepare", ci);
  assert.equal(result.status, 0, output(result));
  return output(result);
};

test("stale self-host inputs stop the normal suite before creating a run or starting a server", () =>
  fixture((root, command) => {
    prepare(command);
    writeFileSync(join(root, "packages/ui/index.ts"), "export const value = 2;\n");
    const result = command("suite");
    assert.notEqual(result.status, 0);
    assert.match(output(result), /Self-host web build is stale or missing/);
    assert.match(output(result), /bun run e2e:prepare/);
    assert.equal(existsSync(join(root, ".local/e2e")), false);
  }));

test("fresh builds and cache restores carry a matching stamp; missing or malformed stamps fail", () =>
  fixture((root, command) => {
    prepare(command);
    assert.equal(command("e2e-check-web").status, 0);
    const dist = join(root, "apps/hosted/self-host/web/dist");
    const stamp = join(dist, ".e2e-inputs.json");
    const expected = JSON.parse(readFileSync(stamp, "utf8"));
    assert.match(expected.inputs, /^[a-f0-9]{64}$/);
    rmSync(dist, { recursive: true });
    assert.match(prepare(command), /hosted:self-host:web:build: cached/);
    assert.equal(command("e2e-check-web").status, 0);
    rmSync(stamp);
    assert.match(output(command("e2e-check-web")), /bun run e2e:prepare/);
    writeFileSync(stamp, "not JSON");
    assert.match(output(command("e2e-check-web")), /bun run e2e:prepare/);
  }));

test("CI builds without the cache still stamp current inputs and pass the suite preflight", () =>
  fixture((root, command) => {
    assert.match(prepare(command, true), /without the cache/);
    assert.equal(command("e2e-check-web", true).status, 0);
    const result = command("suite", true);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /No scheduled scenarios match/);
    assert.doesNotMatch(output(result), /Self-host web build is stale or missing/);
    assert.equal(existsSync(join(root, ".local/e2e")), true);
  }));

test("a failed web rebuild invalidates the previous stamp", () =>
  fixture((root, command) => {
    prepare(command);
    writeFileSync(join(root, "packages/ui/index.ts"), "export const value = 3;\n");
    assert.notEqual(command("e2e-prepare", false, "hosted:self-host:web:build").status, 0);
    assert.match(output(command("e2e-check-web")), /Self-host web build is stale or missing/);
    assert.equal(existsSync(join(root, "apps/hosted/self-host/web/dist/.e2e-inputs.json")), false);
  }));
