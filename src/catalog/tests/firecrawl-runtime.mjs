import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout. Firecrawl is never called: fetch answers with a trimmed
// copy of Firecrawl's OpenAPI document. `--print-kinds` prints the kinds instead of checking them.
const root = process.argv[2];
assert.ok(root, "Pass the prepared Basalt checkout as the first argument");
const print = process.argv[3] === "--print-kinds";
const source = JSON.parse(await readFile(join(root, "src/catalog/firecrawl.json"), "utf8"));
const document = await readFile(join(root, "src/catalog/tests/firecrawl-openapi.json"), "utf8");
const framework = join(root, ".upstream/packages/apps/src");
const load = (path) => import(pathToFileURL(path).href);
const directory = await mkdtemp(join(tmpdir(), "firecrawl-runtime-"));
const publicExports = {
  "apps/openapi": "openapi.ts",
  "apps/operations/approval": "approval.ts",
};
const rewriteImports = (content) => {
  for (const [name, file] of Object.entries(publicExports))
    content = content.replaceAll(
      JSON.stringify(name),
      JSON.stringify(pathToFileURL(join(framework, file)).href),
    );
  return content;
};
try {
  for (const file of source.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.path.endsWith(".ts") ? rewriteImports(file.content) : file.content,
    );
  }
  const fetch = async (input) => {
    assert.equal(String(input), "https://docs.firecrawl.dev/api-reference/v2-openapi.json");
    return new Response(document, { headers: { "content-type": "application/json" } });
  };
  // The kinds the live router gives every generated tool, from the carried options alone.
  const { options } = await load(join(directory, "openapi.ts"));
  const { openapiToolNames } = await load(join(framework, "implementation/openapi-source.ts"));
  const { tools } = await openapiToolNames({ ...options, fetch });
  const kinds = Object.fromEntries(tools.map((tool) => [tool.operationId, tool.kind]));
  if (print) console.log(JSON.stringify(kinds, null, 2));
  else {
    const pinned = JSON.parse(
      await readFile(join(root, "src/catalog/tests/firecrawl-kinds.json"), "utf8"),
    );
    assert.deepEqual(kinds, pinned, "every Firecrawl operation keeps its pinned kind");
    // Every reclassification names an operation the document still declares as POST.
    const declared = JSON.parse(document);
    const methods = Object.fromEntries(
      Object.values(declared.paths).flatMap((item) =>
        Object.entries(item)
          .filter(([method]) => method !== "servers")
          .map(([method, operation]) => [operation.operationId, method]),
      ),
    );
    for (const operationId of Object.keys(options.kinds))
      assert.equal(methods[operationId], "post", `${operationId} is a declared POST`);
    // The shipped approval policy: every mutation asks, reads don't, and a scrape or search asks
    // only when its options can act on a site or persist state.
    const { approvalFor } = await load(join(directory, "approvals.ts"));
    const decide = async (tool, toolInput) => {
      const approval = approvalFor({ kind: tool.kind }, tool.name);
      return approval === undefined ? "no policy" : await approval({ toolInput });
    };
    for (const tool of tools) {
      const decision = await decide(tool, { body: {} });
      if (tool.kind === "mutation") assert.equal(decision, "user-approval", tool.name);
      else if (["scrapeAndExtractFromUrl", "searchAndScrape"].includes(tool.operationId))
        assert.equal(decision, "approved", tool.name);
      else assert.equal(decision, "no policy", tool.name);
    }
    const byId = Object.fromEntries(tools.map((tool) => [tool.operationId, tool]));
    const reads = [
      { url: "https://example.com", formats: ["markdown", { type: "json" }] },
      { url: "https://example.com", headers: { cookie: "synthetic" }, lockdown: false },
      {
        url: "https://example.com",
        actions: [{ type: "wait", milliseconds: 500 }, { type: "scroll" }, { type: "screenshot" }],
      },
      { url: "https://example.com", profile: { name: "reader", saveChanges: false } },
    ];
    const actsOrPersists = [
      { url: "https://example.com", actions: [{ type: "click", selector: "#submit" }] },
      { url: "https://example.com", actions: [{ type: "write", text: "synthetic" }] },
      { url: "https://example.com", actions: [{ type: "executeJavascript", script: "1" }] },
      { url: "https://example.com", formats: [{ type: "changeTracking" }] },
      { url: "https://example.com", formats: ["changeTracking"] },
      { url: "https://example.com", profile: { name: "signed-in" } },
      { alexandria: [{ provider: "synthetic" }] },
    ];
    for (const options of reads) {
      assert.equal(await decide(byId.scrapeAndExtractFromUrl, { body: options }), "approved");
      const search = { body: { query: "synthetic", scrapeOptions: options } };
      assert.equal(await decide(byId.searchAndScrape, search), "approved");
    }
    for (const options of actsOrPersists) {
      const scrape = await decide(byId.scrapeAndExtractFromUrl, { body: options });
      assert.equal(scrape, "user-approval", JSON.stringify(options));
      const search = { body: { query: "synthetic", scrapeOptions: options } };
      assert.equal(
        await decide(byId.searchAndScrape, search),
        "user-approval",
        JSON.stringify(options),
      );
    }
    console.log("Firecrawl generated operation kinds and approvals PASS");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
