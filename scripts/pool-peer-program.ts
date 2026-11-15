import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("src/pool/home-peer-program.json", root);

/** The old image has no peer modules. Bundle the canonical code instead of accepting a program from an operator. */
export function homePeerProgram() {
  const program = ["home_peer_wire.py", "home_peer.py", "home_peer_bootstrap.py"]
    .map((name) =>
      readFileSync(new URL(`containers/pool/${name}`, root), "utf8")
        .replace(/^from __future__ import annotations\n/gm, "")
        .replace(/^from \.home_peer(?:_wire)? import .+\n/gm, ""),
    )
    .join("\n");
  return {
    format: "home-peer-program-v1",
    sourceSha: createHash("sha256").update(program).digest("hex"),
    program,
  };
}

export function checkHomePeerProgram() {
  if (readFileSync(output, "utf8") !== JSON.stringify(homePeerProgram(), null, 2) + "\n")
    throw new Error(
      "Bundled Home peer program is stale; run node scripts/pool-peer-program.ts --write",
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--write")
    writeFileSync(output, JSON.stringify(homePeerProgram(), null, 2) + "\n");
  else checkHomePeerProgram();
}
