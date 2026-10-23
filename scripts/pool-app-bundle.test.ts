import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brand } from "../brand.ts";
import { bundlePoolApp } from "./pool-app-bundle.ts";

test("bundles nested UI, pins the host framework, rewrites the origin and copies the signer", () => {
  const root = mkdtempSync(join(tmpdir(), "pool-bundle-"));
  const upstream = join(root, ".upstream");
  try {
    for (const directory of [
      "apps/pool/ui/public",
      "apps/pool/__tests__",
      "src/pool",
      ".upstream/packages/apps",
      ".upstream/packages/ui/src/implementation/styles/fonts",
    ])
      mkdirSync(join(root, directory), { recursive: true });
    for (const [path, content] of Object.entries({
      "apps/pool/index.ts": "export default {};",
      "apps/pool/deployment.ts": "old origin",
      "apps/pool/package.json": JSON.stringify({ dependencies: { apps: "old", react: "19" } }),
      "apps/pool/ui/page.tsx": "export default () => null;",
      "apps/pool/ui/page.test.tsx": "excluded",
      "apps/pool/__tests__/fixture.ts": "excluded",
      "src/pool/token.ts": "export const signer = true;",
      "apps/pool/ui/public/fonts.css": "stale local copy",
      ".upstream/packages/ui/src/implementation/styles/fonts/geist-sans.woff2": "sans",
      ".upstream/packages/ui/src/implementation/styles/fonts/geist-mono.woff2": "mono",
      ".upstream/packages/ui/src/implementation/styles/fonts/LICENSE.txt": "Open Font License",
      ".upstream/packages/apps/package.json": JSON.stringify({
        version: "0.0.1-beta.104-basalt.1",
      }),
    }))
      writeFileSync(join(root, path), content);
    const files = bundlePoolApp(root, upstream);
    assert.deepEqual(
      files.map((file) => file.path),
      ["deployment.ts", "index.ts", "package.json", "ui/page.tsx", "ui/public/fonts.css"],
    );
    // The page links the faces from the router, which serves the copies the bundler placed.
    const fonts = files[4]!.content;
    assert.match(fonts, new RegExp(`url\\("https://${brand.host.replaceAll(".", "\\.")}/brand/fonts/geist-sans\\.woff2"\\)`));
    assert.match(fonts, /font-family: "Geist Mono";/);
    for (const [file, content] of [["geist-sans.woff2", "sans"], ["geist-mono.woff2", "mono"], ["LICENSE.txt", "Open Font License"]])
      assert.equal(readFileSync(join(root, "public/brand/fonts", file), "utf8"), content);
    assert.equal(files[0]!.content, `export const poolOrigin = "https://${brand.host}";\n`);
    assert.deepEqual(JSON.parse(files[2]!.content).dependencies, {
      apps: "0.0.1-beta.104-basalt.1",
      react: "19",
    });
    const output = join(upstream, "apps/hosted/server/src/implementation");
    const generated = readFileSync(join(output, "pool-app-source.ts"), "utf8");
    assert.equal(
      readFileSync(join(output, "pool-token.ts"), "utf8"),
      "export const signer = true;",
    );
    bundlePoolApp(root, upstream);
    assert.equal(readFileSync(join(output, "pool-app-source.ts"), "utf8"), generated);
    writeFileSync(join(root, "apps/pool/ui/page.tsx"), "changed UI");
    bundlePoolApp(root, upstream);
    assert.notEqual(
      readFileSync(join(output, "pool-app-source.ts"), "utf8").match(
        /export const poolAppVersion = .+/,
      )?.[0],
      generated.match(/export const poolAppVersion = .+/)?.[0],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the router lets pool pages on app origins load the brand fonts", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /^\/brand\/fonts\/\*\n  Access-Control-Allow-Origin: \*$/m);
});
