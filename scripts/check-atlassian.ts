import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyConnectorsSource } from "./connectors-source.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prepared = verifyConnectorsSource(root);
console.log(`Pinned runtime verified (${prepared.commit.slice(0, 7)}, ${prepared.patches.length} carried patches).`);
if (!process.argv.includes("--preflight")) {
  const { runAtlassianProof } = await import("./atlassian-tests/run.ts");
  const result = await runAtlassianProof({ root, upstream: join(root, ".upstream"), commit: prepared.commit });
  console.log(`Atlassian runtime proof passed (${result.checks} checks; ${result.nativeClients} native clients passed).`);
}
