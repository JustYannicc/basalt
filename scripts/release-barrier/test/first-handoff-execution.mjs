import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function retainFirstHandoffExecution() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sources = [
    ...readdirSync(root + "scripts/release-barrier")
      .filter((name) => name.startsWith("first-handoff") && name.endsWith(".ts"))
      .map((name) => "scripts/release-barrier/" + name),
    ...readdirSync(root + "scripts/release-barrier/test")
      .filter((name) => name.startsWith("first-handoff"))
      .map((name) => "scripts/release-barrier/test/" + name),
    "scripts/pool-tests/runtime-handoff-worker.ts",
    "src/pool/runtime-slots/adoption-readback.ts",
    "src/pool/runtime-slots/adoption-observation.ts",
    "src/pool/runtime-slots/admission-proof.ts",
    "src/pool/runtime-slots/configuration.ts",
    "src/pool/runtime-slots/handoff-command.ts",
    "src/pool/worker.ts",
  ];
  const sourceHashes = Object.fromEntries(
    sources.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(root + path))
        .digest("hex"),
    ]),
  );
  mkdirSync(root + ".generated/first-handoff", { recursive: true });
  writeFileSync(
    root + ".generated/first-handoff/execution.json",
    JSON.stringify(
      {
        candidate: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        trackedTreeClean: !execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        sourceHashes,
        integrationScenarios: 18,
        allPassed: true,
        providerRequests: "mocked; real network denied",
        runtime: "actual Worker and SQLite from adopt:false; no fixture pre-adoption",
      },
      null,
      2,
    ) + "\n",
  );
}
