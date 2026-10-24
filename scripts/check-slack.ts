import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyConnectorsSource } from "./connectors-source.ts";
import { assertSourceKeepsSlackTools, readSlackPackage, slackUserMethod } from "./slack-tests/catalog.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readSlackPackage(root);
assertSourceKeepsSlackTools(source);
slackUserMethod(source);
const prepared = verifyConnectorsSource(root);
console.log(`Pinned runtime verified (${prepared.commit.slice(0, 7)}, ${prepared.patches.length} carried patches).`);
if (!process.argv.includes("--preflight")) {
  const { runSlackProof } = await import("./slack-tests/run.ts");
  const result = await runSlackProof({
    root,
    upstream: join(root, ".upstream"),
    commit: prepared.commit,
    installDiagnostic: process.argv.includes("--install-diagnostic"),
    callbackDiagnostic: process.argv.includes("--callback-diagnostic"),
  });
  console.log(result.installDiagnostic
    ? `Slack install diagnostic completed (${result.checks} checks).`
    : result.callbackDiagnostic
      ? `Slack callback diagnostic completed (${result.checks} checks).`
      : `Slack user-token runtime proof passed (${result.checks} checks).`);
}
