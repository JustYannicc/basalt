import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function filesBelow(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap(name =>
    name === "node_modules" || name.startsWith(".") ? [] : filesBelow(join(path, name)));
}
