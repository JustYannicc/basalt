import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { discoverApps } from "./source.mjs";
import { hostVersion } from "./host.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "app-discovery-"));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    run(root, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("future directories and nested catalog documents participate without configuration", () =>
  fixture((root, put) => {
    put("apps/brand-new/index.ts", "bad code");
    put("apps/brand-new/helper.test.ts", "test excluded");
    put("apps/brand-new/tests/helper.ts", "test excluded");
    put("apps/brand-new/ui/main.tsx", "browser code");
    put(
      "src/catalog/future/source.json",
      JSON.stringify({
        package: "new-app",
        files: [{ path: "index.ts", content: "new connector" }],
      }),
    );
    put("src/catalog/future/provenance.json", JSON.stringify({ revision: "capture" }));
    put(
      "src/catalog/future/source.published.json",
      JSON.stringify({
        package: "new-app",
        files: [{ path: "index.ts", content: "published evidence" }],
      }),
    );
    const apps = discoverApps(root);
    assert.deepEqual(
      apps.map((app) => app.name),
      ["apps/brand-new", "src/catalog/future/source.json"],
    );
    assert.deepEqual(
      apps[0].files.map((file) => file.path),
      ["index.ts", "ui/main.tsx"],
    );
    assert.equal(apps[1].files[0].bytes.toString(), "new connector");
  }));

test("malformed source document and symlinks fail discovery", () =>
  fixture((root, put) => {
    put("src/catalog/new/source.json", '{"package":"new-app","files":{}}');
    assert.throws(() => discoverApps(root), /Invalid source document/);
    put("src/catalog/new/source.json", "{}");
    mkdirSync(join(root, "apps"), { recursive: true });
    symlinkSync(join(root, "src/catalog"), join(root, "apps/linked"));
    assert.throws(() => discoverApps(root), /symlinks/);
  }));

test("the prepared host manifest supplies the expected framework pin", () =>
  fixture((root, put) => {
    assert.throws(() => hostVersion(root), /prepare/);
    put(
      ".upstream/packages/apps/package.json",
      '{"name":"apps","version":"0.0.1-beta.104-basalt.1"}',
    );
    assert.equal(hostVersion(root), "0.0.1-beta.104-basalt.1");
  }));
