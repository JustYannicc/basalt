import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { candidate } from "./settings.ts";

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ".local/scale-candidate", encoding: "utf8" });
if (revision.status !== 0 || revision.stdout.trim() !== candidate) throw new Error("Scale candidate differs from the frozen commit");
for (const [name, target] of [["node_modules", ".local/scale-candidate/node_modules"], [".upstream", ".local/scale-candidate/.upstream"]]) {
  if (!existsSync(name)) symlinkSync(target, name, "dir");
  else if (realpathSync(name) !== realpathSync(target)) throw new Error("Scale dependencies differ from the prepared candidate");
}
const sources = ["mock", "generator", "sampler"].map((name) => `export const ${name}Source = ${JSON.stringify(readFileSync(`scripts/scale-test/${name}.py`, "utf8"))};`);
writeFileSync("scripts/scale-test/sources.generated.ts", sources.join("\n") + "\n");
