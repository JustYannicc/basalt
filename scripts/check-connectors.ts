import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyConnectorsSource } from "./connectors-source.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prepared = verifyConnectorsSource(root);
console.log(`Pinned runtime verified (${prepared.commit.slice(0, 7)}, ${prepared.patches.length} carried patches).`);
if (!process.argv.includes("--preflight")) {
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error("Expected a frozen Basalt candidate commit.");
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) throw new Error("Native connector proof requires a clean committed candidate.");
  const { runConnectorsProof } = await import("./connectors-tests/run.ts");
  const result = await runConnectorsProof({
    root, upstream: join(root, ".upstream"), commit: prepared.commit, candidate, patches: prepared.patches,
  });
  console.log(`Connector runtime proof passed (${result.checks} checks).`);
}
