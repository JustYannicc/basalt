import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function snapshotUpstreamInputs(root: string) {
  const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")).commit;
  if (typeof pin !== "string" || !/^[a-f0-9]{40}$/.test(pin))
    throw new Error("Expected an immutable upstream commit");
  const files = execFileSync(
    "git",
    ["-C", join(root, ".upstream"), "ls-tree", "-r", "--name-only", "-z", pin],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
  writeFileSync(
    join(root, "scripts/ci/upstream-files.json"),
    JSON.stringify({ pin, files }, null, 2) + "\n",
  );
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(
    "Frozen upstream input files: " +
      snapshotUpstreamInputs(fileURLToPath(new URL("../../", import.meta.url))),
  );
