import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCarryNumbers } from "./upstream-sync/allocations.ts";
import { compareSyncInventories } from "./upstream-sync/compare.ts";
import { strictReplay } from "./upstream-sync/replay.ts";
import {
  loadSyncSnapshot,
  retainSyncSnapshot,
  type SyncInventory,
} from "./upstream-sync/snapshot.ts";

const usage =
  "Usage: node scripts/upstream-sync.ts inventory|replay --ref <commit> --output <new-directory> [--before <inventory.json>] [--objects <repository> --target <exact-commit>]";

export function runSyncCommand(args: string[], root: string) {
  const command = args[0];
  if (command !== "inventory" && command !== "replay") throw new Error(usage);
  const values = new Map<string, string>();
  const allowed =
    command === "replay"
      ? ["--ref", "--output", "--objects", "--target"]
      : ["--ref", "--output", "--before"];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--"))
      throw new Error(usage);
    values.set(key, value);
  }
  const ref = values.get("--ref");
  const destination = values.get("--output");
  if (!ref || !destination) throw new Error(usage);
  const output = resolve(destination);
  mkdirSync(dirname(output), { recursive: true });
  const snapshot = loadSyncSnapshot(root, ref);
  if (command === "replay") {
    const objects = values.get("--objects");
    const target = values.get("--target");
    if (!objects || !target) throw new Error(usage);
    const result = strictReplay(snapshot, { objects, target, output });
    return {
      exitCode: result.passed ? 0 : result.failure?.carry ? 1 : 2,
      summary: {
        basalt: result.basalt.commit,
        target,
        inputSha256: result.inputSha256,
        passed: result.passed,
        applied: result.applied,
        carryCount: result.carryCount,
        failedCarry: result.failure?.carry ?? null,
        unattempted: result.unattempted.length,
      },
    };
  }
  mkdirSync(output, { recursive: false });
  retainSyncSnapshot(snapshot, output);
  const previous = values.get("--before");
  const changes = previous
    ? compareSyncInventories(
        JSON.parse(readFileSync(previous, "utf8")) as SyncInventory,
        snapshot.inventory,
      )
    : null;
  if (changes)
    writeFileSync(join(output, "changes.json"), JSON.stringify(changes, null, 2) + "\n", {
      flag: "wx",
    });
  writeFileSync(
    join(output, "allocations.json"),
    JSON.stringify(syncCarryNumbers, null, 2) + "\n",
    { flag: "wx" },
  );
  return {
    exitCode: 0,
    summary: {
      basalt: snapshot.inventory.basalt.commit,
      inputSha256: snapshot.inventory.inputSha256,
      upstream: snapshot.inventory.upstream.commit,
      carryCount: snapshot.patches.length,
      changes: changes
        ? {
            added: changes.added.length,
            removed: changes.removed.length,
            changed: changes.changed.length,
          }
        : null,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runSyncCommand(
      process.argv.slice(2),
      fileURLToPath(new URL("../", import.meta.url)),
    );
    console.log(JSON.stringify(result.summary));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
