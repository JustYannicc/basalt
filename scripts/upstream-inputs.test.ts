import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dependencyIdentity, requirePreparedBun } from "./upstream-inputs.ts";

test("generated documentation manifests do not change dependency identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "basalt-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  const first = dependencyIdentity(root, "pin");
  mkdirSync(join(root, "apps/docs/.blume/.cache/vite/deps"), { recursive: true });
  writeFileSync(join(root, "apps/docs/.blume/package.json"), '{"type":"module"}');
  writeFileSync(join(root, "apps/docs/.blume/.cache/vite/deps/package.json"), '{"type":"module"}');
  assert.deepEqual(dependencyIdentity(root, "pin"), first);
  writeFileSync(
    join(root, "package.json"),
    '{"name":"fixture","dependencies":{"is-number":"7.0.0"}}',
  );
  assert.notEqual(dependencyIdentity(root, "pin").key, first.key);
});

test("preparation refuses Bun version drift before allocating dependencies", (t) => {
  const mock = t.mock.method(childProcess, "spawnSync", () => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "1.4.4\n",
    stderr: "",
    status: 0,
    signal: null,
  }));
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  assert.throws(requirePreparedBun, /requires Bun 1.4.2/);
});
