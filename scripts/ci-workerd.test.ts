import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { prepareImageContext, workerdAsset } from "./ci/workerd-assets.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "basalt-workerd-"));
  const upstream = join(root, "source");
  const selfHost = join(upstream, "apps/hosted/self-host");
  mkdirSync(selfHost, { recursive: true });
  const bytes = gzipSync("synthetic workerd executable");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = { name: "workerd.gz", sha256 };
  const pin = join(selfHost, "workerd.json");
  writeFileSync(
    pin,
    JSON.stringify({
      repository: "fixture/workerd",
      release: "v1.fixture",
      assets: { "linux-64": asset, "linux-arm64": asset },
    }),
  );
  const archive = join(root, "archive.gz");
  writeFileSync(archive, bytes);
  return { root, upstream, selfHost, archive, pin, sha256 };
}

test("the real carried downloader preserves default HTTP, local bytes and checksum failures", () => {
  const data = fixture();
  try {
    execFileSync(
      "bun",
      [
        "--eval",
        `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { Effect } from 'effect';
      import { HttpClient, HttpClientResponse } from 'effect/http';
      import { pinnedWorkerd } from './apps/hosted/self-host/scripts/package-runtime.ts';
      const archive = ${JSON.stringify(data.archive)};
      const pin = ${JSON.stringify(data.pin)};
      const bytes = readFileSync(archive);
      const expected = { release: 'v1.fixture', binary: Buffer.from('synthetic workerd executable') };
      process.env.EXECUTOR_WORKERD_ARCHIVE = archive;
      assert.deepEqual(await Effect.runPromise(pinnedWorkerd(pin)), expected);
      writeFileSync(archive, 'corrupt gzip');
      await assert.rejects(Effect.runPromise(pinnedWorkerd(pin)), /has SHA-256.*workerd.json pins/);
      process.env.EXECUTOR_WORKERD_ARCHIVE = archive + '.missing';
      await assert.rejects(Effect.runPromise(pinnedWorkerd(pin)), /ENOENT/);
      delete process.env.EXECUTOR_WORKERD_ARCHIVE;
      let requests = 0;
      const client = HttpClient.make((request, url) => {
        requests++;
        assert.equal(url.toString(), 'https://github.com/fixture/workerd/releases/download/v1.fixture/workerd.gz');
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes)));
      });
      const download = () => Effect.runPromise(pinnedWorkerd(pin).pipe(Effect.provideService(HttpClient.HttpClient, client)));
      assert.deepEqual(await download(), expected);
      assert.equal(requests, 1);
      const corrupt = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request, new Response('corrupt'))));
      await assert.rejects(Effect.runPromise(pinnedWorkerd(pin).pipe(Effect.provideService(HttpClient.HttpClient, corrupt))), /has SHA-256.*workerd.json pins/);
    `,
      ],
      { cwd: new URL("../.upstream/", import.meta.url), stdio: "pipe" },
    );
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("the image context uses verified local bytes and leaves the prepared source unchanged", () => {
  const data = fixture();
  try {
    const command = "RUN bun run --cwd apps/hosted/self-host package:runtime";
    const dockerfile = join(data.selfHost, "Dockerfile");
    writeFileSync(dockerfile, command + "\n");
    writeFileSync(
      join(data.upstream, "package.json"),
      JSON.stringify({
        dependencies: { dugite: "1", electron: "1" },
        trustedDependencies: ["dugite", "electron", "esbuild"],
      }),
    );
    writeFileSync(
      join(data.upstream, "bun.lock"),
      '{"trustedDependencies":["dugite","electron","esbuild"]}',
    );
    for (const directory of ["node_modules", ".git", ".alchemy", "dist"]) {
      mkdirSync(join(data.upstream, directory));
      writeFileSync(join(data.upstream, directory, "excluded"), "excluded");
    }
    writeFileSync(join(data.upstream, ".env.fixture"), "synthetic");
    const target = join(data.root, "image");
    prepareImageContext(data.upstream, target, data.archive);
    assert.equal(readFileSync(dockerfile, "utf8"), command + "\n");
    assert.match(
      readFileSync(join(target, "apps/hosted/self-host/Dockerfile"), "utf8"),
      /EXECUTOR_WORKERD_ARCHIVE=\/build\/apps\/hosted\/self-host\/\.ci-workerd\/archive.gz/,
    );
    assert.deepEqual(
      readFileSync(join(target, "apps/hosted/self-host/.ci-workerd/archive.gz")),
      readFileSync(data.archive),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, "package.json"), "utf8")).trustedDependencies,
      ["esbuild"],
    );
    for (const excluded of ["node_modules", ".git", ".alchemy", "dist", ".env.fixture"])
      assert.equal(existsSync(join(target, excluded)), false);
    assert.deepEqual(
      JSON.parse(readFileSync(join(data.upstream, "package.json"), "utf8")).trustedDependencies,
      ["dugite", "electron", "esbuild"],
    );
    assert.ok(workerdAsset(data.upstream).key.includes(data.sha256));
    writeFileSync(data.archive, "bad");
    const refused = join(data.root, "refused");
    assert.throws(
      () => prepareImageContext(data.upstream, refused, data.archive),
      /checksum mismatch/,
    );
    assert.equal(existsSync(refused), false);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("only the selected workerd warming job can populate a missing archive cache", () => {
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.equal(
    workflow.jobs["workerd-assets"].if,
    "contains(fromJSON(needs.select.outputs.jobs), 'upstream-image')",
  );
  assert.deepEqual(workflow.jobs["upstream-image"].needs, ["select", "workerd-assets"]);
  const action = parse(
    readFileSync(new URL("../.github/actions/workerd-assets/action.yml", import.meta.url), "utf8"),
  );
  assert.equal(
    action.runs.steps.find((step: { uses?: string }) => step.uses === "actions/cache/restore@v4")
      .with["fail-on-cache-miss"],
    "${{ inputs.warm != 'true' }}",
  );
  assert.equal(
    action.runs.steps.find((step: { run?: string }) => step.run?.endsWith(" warm")).if,
    "inputs.warm == 'true' && steps.cache.outputs.cache-hit != 'true'",
  );
});
