import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stackFingerprint } from "./fingerprint.ts";
import type { StackInventoryRecord } from "./native-stack.ts";

const toolingFingerprint = createHash("sha256");
for (const name of [
  "native-stack.ts",
  "native-stack-worker.mjs",
  "native-stack-fixtures.ts",
  "generated-inventory.ts",
])
  toolingFingerprint.update(readFileSync(new URL(name, import.meta.url)));
const tooling = toolingFingerprint.digest("hex");
const inventoryPath = (root: string) => join(root, ".generated/architecture/stack-inventory.json");

function isResource(value: unknown): value is StackInventoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const resource = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === "string" && /^resource-[a-f0-9]{64}$/.test(value);
  return (
    id(resource.id) &&
    typeof resource.kind === "string" &&
    resource.source === "alchemy.run.ts" &&
    typeof resource.declaredName === "string" &&
    (resource.ownerId === undefined || id(resource.ownerId))
  );
}

export function writeGeneratedInventory(
  root: string,
  source: string,
  inventory: StackInventoryRecord[],
): void {
  const path = inventoryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ source, tooling, inventory }));
}

/** Only reuse generation's native evaluation while both source and evaluator match. */
export function readGeneratedInventory(root: string): StackInventoryRecord[] | undefined {
  const path = inventoryPath(root);
  if (!existsSync(path)) return undefined;
  const snapshot: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const record = snapshot as Record<string, unknown>;
  if (record.tooling !== tooling || record.source !== stackFingerprint(root)) return undefined;
  if (!Array.isArray(record.inventory) || !record.inventory.every(isResource))
    throw new Error("Invalid generated stack inventory; rerun architecture:deployment");
  return record.inventory;
}
