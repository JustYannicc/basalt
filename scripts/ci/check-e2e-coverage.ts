import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { coverageErrors, coverageInventory } from "./e2e-coverage.ts";
import { readDeclarations } from "./declarations.ts";
import { filesForTarget, scenarios } from "../../.upstream/e2e/test-plan.ts";

const root = process.cwd();
const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const inventory = coverageInventory(
  root,
  readDeclarations(root),
  parse(readFileSync(".github/workflows/ci.yml", "utf8")),
  scenarios,
  filesForTarget,
  readdirSync(".github/workflows")
    .filter((file) => file !== "ci.yml" && /\.ya?ml$/.test(file))
    .map((file) => parse(readFileSync(`.github/workflows/${file}`, "utf8"))),
);
const exceptions = process.argv.includes("--no-exceptions")
  ? []
  : JSON.parse(readFileSync("scripts/ci/e2e-exceptions.json", "utf8"));
const errors = coverageErrors(inventory, exceptions);
mkdirSync(".generated/ci", { recursive: true });
const report = {
  tests: inventory.length,
  selected: inventory.filter((item) => item.selected).length,
  exceptions: inventory.filter((item) => !item.selected),
  errors,
};
writeFileSync(".generated/ci/e2e-coverage.json", JSON.stringify(report, null, 2) + "\n");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `E2E coverage: ${report.tests} test/script identities, ${report.selected} selected, ${report.exceptions.length} reviewed exceptions`,
  );
