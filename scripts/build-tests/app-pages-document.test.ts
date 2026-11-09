import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { workerBuild } from "../../.upstream/apps/hosted/cloud/src/infrastructure/worker-build.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");
const { build } = require("esbuild") as typeof import("esbuild");
const { parse, serialize } =
  await import("../../.upstream/packages/apps/node_modules/parse5/dist/index.js");
const { versionDocument } =
  await import("../../.upstream/packages/apps/src/implementation/ui-document.ts");

test("native app documents preserve portable resource rewriting across HTML parser states", async () => {
  const bundled = await build({
    stdin: {
      contents: `import { versionDocument } from "./ui-document.ts";
        export default { async fetch(request) {
          return new Response((await versionDocument(await request.text(), "version /one")).replace("<!--executor-ui-->", '<meta name="fixture-bootstrap" content="loaded">'));
        } };`,
      resolveDir: fileURLToPath(
        new URL("../../.upstream/packages/apps/src/implementation/", import.meta.url),
      ),
      sourcefile: "native-document-fixture.ts",
    },
    plugins: [
      {
        name: "production-document-aliases",
        setup(builder) {
          const aliases = workerBuild("app-pages").input?.resolve?.alias;
          assert.ok(aliases && !Array.isArray(aliases));
          builder.onResolve({ filter: /ui-document(?:-decode)?[.]ts$/ }, (args) => {
            const replacement = aliases[resolve(args.resolveDir, args.path)];
            assert.ok(typeof replacement === "string", "production binds both document adapters");
            return { path: replacement };
          });
        },
      },
    ],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
  });
  const worker = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
  });
  const documents = [
    `<!doctype html><html><head><link rel="stylesheet preload" href="./style.css?x=1&amp;y=2"><link rel="canonical" href="inbox"><style>@import "imported.css"; .a { background: url("mark\\2e svg"); content: "url(mark.svg)"; }</style></head><body><a href="inbox">Link</a><form action="save"><input type="image" src="mark.svg"></form><img src="mark.svg" srcset="data:image/svg+xml,%3Csvg%3E 1x, mark.svg 2x"><svg><use xlink:href="mark.svg#one"></use><image href="mark.svg"></image><filter><feImage href="mark.svg"></feImage></filter></svg><template><img src="mark.svg"><style>.b{background:url(mark.svg)}</style></template><!--executor-ui--></body></html>`,
    `<style>${"/* text chunk */".repeat(12_000)} .a { background: u\\72l(mark.svg); border-image: url("mark.svg"/**/); }</style><style>.b{background:url(second.svg)}</style><div style='background: url(&quot;mark.svg&quot;); color: red'>&copy;&amp;</div>`,
    `<table><tr><td><img src="../mark.svg?x=1#two"></table><img src="/root.svg"><img src="https://example.invalid/mark.svg"><img src="#mark"><img src="?mark"><iframe src="frame"></iframe><object data="mark.svg"></object>`,
    `<img src="&#x2f;root.svg"><img src="caf&eacute;.svg?x=&amp;copy;&amp;y=2"><img src="one.svg" src="two.svg"><script>const html = '<img src="skip.svg">';</script><textarea>&amp;raw</textarea><template><div style="background: url(&quot;with&#32;space.svg&quot;)"></div></template>`,
    `<html><head><title>&lt;!--executor-ui--&gt;</title></head><body><div title="<!--executor-ui-->"></div><textarea><!--executor-ui--></textarea><!--executor-ui--></body></html>`,
    `<html><head><title>${"t".repeat(65_530)}<!--executor-ui--></title></head><body><textarea><!--executor-ui--></textarea><!--executor-ui--></body></html>`,
    `<html><head><noscript><img src="no-script.svg"></noscript></head><body><svg><style>.a{background:url(mark&#x2e;svg)}</style><text>&amp;raw</text></svg><xmp><img src="literal.svg"></xmp><iframe><img src="frame.svg"></iframe><!--executor-ui--></body></html>`,
  ];
  try {
    for (const [index, html] of documents.entries()) {
      const response = await worker.dispatchFetch("https://fixture.invalid/document", {
        method: "POST",
        body: html,
      });
      assert.equal(response.status, 200);
      const native = await response.text();
      const actual = serialize(parse(native));
      const expected = serialize(
        parse(
          (await versionDocument(html, "version /one")).replace(
            "<!--executor-ui-->",
            '<meta name="fixture-bootstrap" content="loaded">',
          ),
        ),
      );
      let mismatch = 0;
      while (mismatch < actual.length && actual[mismatch] === expected[mismatch]) mismatch++;
      assert.ok(
        actual === expected,
        JSON.stringify({
          document: index,
          mismatch,
          actual: actual.slice(Math.max(0, mismatch - 80), mismatch + 200),
          expected: expected.slice(Math.max(0, mismatch - 80), mismatch + 200),
          actualLength: actual.length,
          expectedLength: expected.length,
        }),
      );
    }
  } finally {
    await worker.dispose();
  }
});
