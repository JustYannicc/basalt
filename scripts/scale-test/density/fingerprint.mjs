import { readFileSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = process.env.DENSITY_OUTPUT;
if (!out) throw Error("Density output must be explicit");
mkdirSync(out, { recursive: true });
const files = {};
for (const name of readdirSync(source)) {
  const data = readFileSync(join(source, name));
  files[name] = createHash("sha256").update(data).digest("hex");
  copyFileSync(join(source, name), join(out, name));
}
writeFileSync(
  join(out, "fixture-fingerprints.json"),
  JSON.stringify(
    {
      frozenAtUtc: new Date().toISOString(),
      harnessHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      runtimeSource: "53d3a3730859fd2b46f435cdaaa6ffedaf73400b",
      entrypoint: "run-density.mjs",
      files,
      image: readFileSync(join(out, "image.id"), "utf8").trim(),
      cpu: JSON.parse(execFileSync("lscpu", ["--json"], { encoding: "utf8" })),
      architecture: process.arch,
      bun: process.versions.bun,
    },
    null,
    2,
  ) + "\n",
);
