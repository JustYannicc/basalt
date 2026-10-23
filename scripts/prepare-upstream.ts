import { existsSync, readFileSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = join(root, ".upstream");
const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
if (!/^[a-f0-9]{40}$/.test(pin.commit)) throw new Error("Expected an immutable upstream commit");
if (!existsSync(join(upstream, ".git"))) {
  run("git", ["init", upstream]);
  run("git", ["remote", "add", "origin", pin.repository], upstream);
}
run("git", ["fetch", "--depth=1", "origin", pin.commit], upstream);
// .upstream is generated dependency source. Alchemy state and node_modules are untracked.
run("git", ["checkout", "--detach", "--force", pin.commit], upstream);
for (const patch of readdirSync(join(root, "patches"))
  .filter((file) => file.endsWith(".patch"))
  .sort()) {
  const path = join(root, "patches", patch);
  const additions = [
    ...readFileSync(path, "utf8").matchAll(/--- \/dev\/null\n\+\+\+ b\/(.+)\n/g),
  ].map((match) => match[1]!);
  for (const added of additions) {
    if (added.startsWith("/") || added.split("/").includes(".."))
      throw new Error("Invalid patch path");
  }
  // Remove only patch-created, untracked source files from this generated checkout.
  if (additions.length) run("git", ["clean", "-f", "--", ...additions], upstream);
  run("git", ["apply", "--check", path], upstream);
  run("git", ["apply", path], upstream);
}
run("bun", ["install", "--frozen-lockfile"], upstream);
const modules = join(root, "node_modules");
if (!existsSync(modules)) symlinkSync(".upstream/apps/hosted/cloud/node_modules", modules, "dir");
else if (!lstatSync(modules).isSymbolicLink())
  throw new Error("Basalt node_modules must link to the pinned cloud dependencies");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" });
if (revision.stdout.trim() !== pin.commit)
  throw new Error("Upstream checkout differs from the pin");
