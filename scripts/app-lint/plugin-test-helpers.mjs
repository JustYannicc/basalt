import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const oxlint = join(directory, "node_modules/oxlint/bin/oxlint");
const plugin = fileURLToPath(new URL("./plugin.mjs", import.meta.url));

function check(rule, cases) {
  const scratch = mkdtempSync(join(tmpdir(), "executor-app-lint-plugin-"));
  try {
    const config = join(scratch, ".oxlintrc.json");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        plugins: [],
        jsPlugins: [{ name: "executor-apps", specifier: plugin }],
        rules: { [`executor-apps/${rule}`]: "error" },
      }),
    );
    const files = cases.flatMap((item, index) => {
      const sources = item.files ?? { "index.ts": item.source };
      return Object.entries(sources).map(([name, source]) => {
        const path = `case-${index}/${name}`;
        const absolute = join(scratch, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, source);
        return path;
      });
    });
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", config, "--no-ignore", "--threads", "1", "--format", "json", ...files],
      {
        cwd: scratch,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    assert.ifError(result.error);
    assert.ok([0, 1].includes(result.status), result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    return cases.map((item, index) => {
      const filename = resolve(scratch, `case-${index}/${item.entry ?? "index.ts"}`);
      return {
        expected: item.expected,
        diagnostics: (output.diagnostics ?? []).filter(
          (diagnostic) => resolve(scratch, diagnostic.filename ?? "") === filename,
        ),
      };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function assertCases(rule, cases) {
  if (cases.some((item) => item.rule && item.rule !== rule)) {
    for (const selected of new Set(cases.map((item) => item.rule ?? rule)))
      assertCases(
        selected,
        cases.filter((item) => (item.rule ?? rule) === selected),
      );
    return;
  }
  const results = check(rule, cases);
  for (const [index, result] of results.entries()) {
    if (result.expected === null)
      assert.equal(
        result.diagnostics.length,
        0,
        `${rule} case ${index}: ${JSON.stringify(result.diagnostics)}`,
      );
    else {
      assert.equal(
        result.diagnostics.length,
        1,
        `${rule} case ${index}: ${JSON.stringify(result.diagnostics)}`,
      );
      assert.ok(
        result.diagnostics[0].message.includes(result.expected),
        `${rule} case ${index}: ${result.diagnostics[0].message}`,
      );
    }
  }
}
