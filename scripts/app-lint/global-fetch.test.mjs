import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const oxlint = fileURLToPath(new URL("./node_modules/oxlint/bin/oxlint", import.meta.url));
const rule = new URL("./global-fetch.mjs", import.meta.url).href;

test("global-object fetch analysis catches aliases, assignments and destructuring without confusing context HTTP", () => {
  const scratch = mkdtempSync(join(tmpdir(), "global-fetch-rule-"));
  try {
    writeFileSync(
      join(scratch, "plugin.mjs"),
      `import { noGlobalFetchRule } from ${JSON.stringify(rule)};\nexport default { meta: { name: 'http-rule' }, rules: { check: noGlobalFetchRule } };`,
    );
    writeFileSync(
      join(scratch, ".oxlintrc.json"),
      JSON.stringify({
        categories: { correctness: "off" },
        plugins: [],
        jsPlugins: ["./plugin.mjs"],
        rules: { "http-rule/check": "error" },
      }),
    );
    const sources = [
      'const host = globalThis; host.fetch("https://example.com");',
      'let host = globalThis; const other = host; other["fetch"]("https://example.com");',
      'let host; host = globalThis; host.fetch("https://example.com");',
      'const host = globalThis; const { fetch: request } = host; request("https://example.com");',
      'export const request = (ctx) => { const host = ctx; return host.fetch("https://example.com"); };',
      'export const request = (globalThis) => { const host = globalThis; return host.fetch("https://example.com"); };',
    ];
    for (const [index, source] of sources.entries())
      writeFileSync(join(scratch, `case-${index}.ts`), source);
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", ".oxlintrc.json", "--threads", "2", "--format", "json", "."],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    for (let index = 0; index < sources.length; index++) {
      const found = diagnostics.filter((item) => item.filename.endsWith(`case-${index}.ts`));
      assert.equal(found.length, index < 4 ? 1 : 0, JSON.stringify(found));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
