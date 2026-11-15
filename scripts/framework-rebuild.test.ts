import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  frameworkPreparation,
  pinPreparation,
  pinnedPreparation,
  rebuildInput,
  sha256,
  verifyGeneration,
} from "./framework-rebuild/input.ts";
import { frameworkHashes, hashManifest, moduleMapSha256 } from "./framework-rebuild/manifest.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

const uuid = "8ea3f213-61a1-4f8d-8f53-57c977e06c4e";
const key = "a".repeat(64);
const commit = "b".repeat(40);
const environment = {
  REBUILD_COMMIT: commit,
  REBUILD_TOOLCHAIN: "ubuntu-24.04-bun-1.4.2",
  REBUILD_GENERATION_UUID: uuid,
  REBUILD_DEPENDENCY_KEY: key,
};
const input = rebuildInput(environment);
const helper = `import { join } from "node:path";
const upstreamCache = () => "/synthetic-cache";
const pin = "synthetic-pin";
export function prepare(key) {
  const entry = join(upstreamCache(), "prepared", pin, key);
  const id = randomUUID();
  return { key, entry, id };
}`;
const entry =
  'await installUpstreamDependencies(upstream, pin.commit);\nthrow new Error("unrelated Worker build");\n';

test("rebuild inputs preserve logged profiles and refuse partial or injectable identities", () => {
  assert.equal(input.checkout, "candidate");
  for (const profile of ["ubuntu-24.04-bun-1.4.4", "ubuntu-24.04-bun-1.4.4-workspace"]) {
    const direct = rebuildInput({
      ...environment,
      REBUILD_TOOLCHAIN: profile,
      REBUILD_GENERATION_UUID: "",
      REBUILD_DEPENDENCY_KEY: "",
    });
    assert.equal(direct.bun, "1.4.4");
    assert.equal(direct.uuid, "");
    assert.equal(direct.key, "");
  }
  assert.equal(
    rebuildInput({ ...environment, REBUILD_TOOLCHAIN: "ubuntu-26.04-bun-1.4.2" }).runner,
    "ubuntu-26.04",
  );
  for (const fields of [
    { REBUILD_COMMIT: "main" },
    { REBUILD_COMMIT: `${commit}; echo unsafe` },
    { REBUILD_GENERATION_UUID: "" },
    { REBUILD_DEPENDENCY_KEY: "" },
    { REBUILD_DEPENDENCY_KEY: "../cache" },
    { REBUILD_GENERATION_UUID: "not-a-uuid" },
    { REBUILD_TOOLCHAIN: "ubuntu-latest" },
    { REBUILD_TOOLCHAIN: "__proto__" },
  ])
    assert.throws(() => rebuildInput({ ...environment, ...fields }));
});

test("the historical calculated key refuses before an install while the UUID is pinned", () => {
  const patched = pinnedPreparation(helper, input);
  const invoke = (actual: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${patched}\nconsole.log(JSON.stringify(prepare(process.argv[1])));`,
        actual,
      ],
      { encoding: "utf8" },
    );
  const matched = invoke(key);
  assert.equal(matched.status, 0, matched.stderr);
  const result: unknown = JSON.parse(matched.stdout);
  assert.deepEqual(result, {
    key,
    entry: `/synthetic-cache/prepared/synthetic-pin/${key}`,
    id: uuid,
  });
  const refused = invoke("c".repeat(64));
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, "");
  assert.match(
    refused.stderr,
    new RegExp(`FRAMEWORK_REBUILD_KEY_MISMATCH expected=${key} actual=${"c".repeat(64)}`),
  );
  assert.throws(() => pinnedPreparation(helper + helper, input));
  assert.throws(() => pinnedPreparation(helper.replace("randomUUID()", "anotherUUID()"), input));
});

test("framework preparation executes source and dependencies without later app or Worker builds", () => {
  for (const boundary of [
    'await installUpstreamDependencies(upstream, pin.commit, process.argv.includes("--cache-hit-only"));',
    "await installUpstreamDependencies(upstream, pin.commit);",
    'run("bun", ["install", "--frozen-lockfile"], upstream);',
  ]) {
    const source = `const upstream = ".upstream", pin = { commit: "pin" };
const calls = ["source"];
const installUpstreamDependencies = async () => { calls.push("dependencies"); console.log(JSON.stringify(calls)); };
const run = () => { calls.push("dependencies"); console.log(JSON.stringify(calls)); };
${boundary}\nthrow new Error("must not build a Worker");`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", frameworkPreparation(source)],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["source", "dependencies"]);
  }
  assert.throws(() => frameworkPreparation("unknown preparation"));
});

test("historical entry and generation helper are restored; direct installs invent no identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "framework-preparation-")));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/prepare-upstream.ts"), entry);
    const direct = rebuildInput({
      ...environment,
      REBUILD_GENERATION_UUID: "",
      REBUILD_DEPENDENCY_KEY: "",
    });
    assert.throws(() => pinPreparation(root, input), /direct-install/);
    const directPreparation = pinPreparation(root, direct);
    assert.equal(directPreparation.layout, "direct");
    directPreparation.restore();
    assert.equal(readFileSync(join(root, "scripts/prepare-upstream.ts"), "utf8"), entry);
    writeFileSync(join(root, "scripts/upstream-dependencies.ts"), helper);
    assert.throws(() => pinPreparation(root, direct), /historical generation/);
    const generation = pinPreparation(root, input);
    generation.restore();
    assert.equal(readFileSync(join(root, "scripts/upstream-dependencies.ts"), "utf8"), helper);
    assert.equal(readFileSync(join(root, "scripts/prepare-upstream.ts"), "utf8"), entry);
    const store = join(root, ".cache/basalt/upstream/prepared/pin", key, "generations", uuid);
    mkdirSync(store, { recursive: true });
    mkdirSync(join(root, ".upstream"));
    writeFileSync(
      join(root, ".upstream/.basalt-dependencies.json"),
      JSON.stringify({ key, store }),
    );
    verifyGeneration(root, input, root, "pin");
    assert.throws(() => verifyGeneration(root, { ...input, uuid: "another" }, root, "pin"));
    assert.throws(() => verifyGeneration(root, direct, root, "pin"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hashes bind identical runtime bytes in both packages and reject mismatched copies", () => {
  const runtime = Buffer.from(
    JSON.stringify({
      version: "fixture.1",
      protocol: 41,
      server: { "private/module/name": "private body" },
      browser: { "browser.js": "browser body" },
    }),
  );
  const packed = Buffer.from(
    JSON.stringify({ "runtime.json": runtime.toString(), "index.d.ts": "type Private = string" }),
  );
  const result = frameworkHashes(runtime, packed, runtime);
  assert.equal(
    result.serverModuleMapSha256,
    moduleMapSha256({ "private/module/name": "private body" }),
  );
  assert.equal(result.declarations[0]?.sha256, sha256("type Private = string"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /private body|private\/module\/name|browser body|type Private/,
  );
  assert.throws(
    () => frameworkHashes(runtime, packed, Buffer.from("changed")),
    /runtime bytes differ/,
  );
  assert.throws(() =>
    frameworkHashes(runtime, Buffer.from('{"runtime.json":"different"}'), runtime),
  );
  assert.throws(() =>
    frameworkHashes(
      runtime,
      Buffer.from(JSON.stringify({ "runtime.json": runtime.toString(), "../private": "body" })),
      runtime,
    ),
  );
});

test("the complete manifest hashes real package files and emits no bodies or absolute paths", () => {
  const root = mkdtempSync(join(tmpdir(), "framework-hashes-"));
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(root, ["init", "-q"]);
    writeFileSync(join(root, ".gitignore"), ".upstream/\n");
    git(root, ["add", ".gitignore"]);
    git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const upstream = join(root, ".upstream");
    mkdirSync(upstream);
    git(upstream, ["init", "-q"]);
    for (const name of [
      "bun.lock",
      "bunfig.toml",
      "package.json",
      "packages/apps/package.json",
      "packages/apps/scripts/build.mjs",
      "scripts/build-basalt-framework.ts",
    ]) {
      mkdirSync(join(upstream, name, ".."), { recursive: true });
      writeFileSync(join(upstream, name), `public source ${name}`);
    }
    writeFileSync(join(upstream, ".gitignore"), "packages/apps/dist/\n.local/\n");
    git(upstream, ["add", "."]);
    git(upstream, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "upstream",
    ]);
    const runtime = JSON.stringify({
      version: "fixture.1",
      protocol: 41,
      server: { "server.js": "secret body" },
      browser: { "browser.js": "body" },
    });
    for (const name of [
      "packages/apps/dist",
      ".local/basalt-framework",
      ".local/test-runtime/package",
    ])
      mkdirSync(join(upstream, name), { recursive: true });
    writeFileSync(join(upstream, "packages/apps/dist/runtime.json"), runtime);
    writeFileSync(
      join(upstream, ".local/basalt-framework/framework.json"),
      JSON.stringify({ "runtime.json": runtime, "index.d.ts": "declaration body" }),
    );
    writeFileSync(join(upstream, ".local/test-runtime/package/runtime.json"), runtime);
    execFileSync("tar", ["-czf", "apps.tgz", "package"], {
      cwd: join(upstream, ".local/test-runtime"),
    });
    const actualInput = { ...input, commit: git(root, ["rev-parse", "HEAD"]) };
    const manifest = hashManifest(root, actualInput, commit);
    assert.equal(manifest.status, "built");
    assert.equal(manifest.bundles.length, 3);
    assert.equal(manifest.framework.declarations.length, 1);
    assert.doesNotMatch(JSON.stringify(manifest), /secret body|declaration body|framework-hashes-/);
    writeFileSync(join(root, "unexpected"), "changed");
    assert.throws(() => hashManifest(root, actualInput, commit), /historical source changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow dispatch has four inputs, no credentials and uploads only the hash manifest", () => {
  const text = readFileSync(
    new URL("../.github/workflows/framework-rebuild.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(Object.keys(workflow.on.workflow_dispatch.inputs).length, 4);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.rebuild.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.rebuild.environment, undefined);
  assert.doesNotMatch(text, /secrets\.|vars\.|deploy|production-ops|repository_dispatch|schedule:/);
  const upload = workflow.jobs.rebuild.steps.find(
    (step: { uses?: string }) => step.uses === "actions/upload-artifact@v4",
  );
  assert.equal(upload.with.path, "${{ runner.temp }}/framework-rebuild-hashes/hash-manifest.json");
});
