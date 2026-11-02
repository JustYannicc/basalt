import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { candidate } from "./settings.ts";

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ".local/scale-candidate", encoding: "utf8" });
if (revision.status !== 0 || revision.stdout.trim() !== candidate) throw new Error("Scale candidate differs from the frozen commit");
for (const [name, target] of [["node_modules", ".local/scale-candidate/node_modules"], [".upstream", ".local/scale-candidate/.upstream"]]) {
  if (!existsSync(name)) symlinkSync(target, name, "dir");
  else if (realpathSync(name) !== realpathSync(target)) throw new Error("Scale dependencies differ from the prepared candidate");
}
const aliasDirectory = "scripts/scale-test/node_modules/@basalt-scale";
mkdirSync(aliasDirectory, { recursive: true });
const alias = `${aliasDirectory}/candidate`;
const snapshot = resolve(".local/scale-candidate");
if (!existsSync(alias)) symlinkSync(snapshot, alias, "dir");
else if (realpathSync(alias) !== realpathSync(snapshot)) throw new Error("Scale source alias differs from the frozen candidate");
const sources = ["mock", "generator", "sampler"].map((name) => `export const ${name}Source = ${JSON.stringify(readFileSync(`scripts/scale-test/${name}.py`, "utf8"))};`);
writeFileSync("scripts/scale-test/sources.generated.ts", sources.join("\n") + "\n");
