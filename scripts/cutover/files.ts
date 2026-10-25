import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ImportFailure, validateImport, type ImportConfig, type ImportAccount } from "./import.ts";

/** Open without following a final symlink; check the open descriptor before reading. */
async function privateJson(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw 0;
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}

export async function loadImportConfig(path: string): Promise<ImportConfig> {
  try {
    const value = await privateJson(path);
    if (!Array.isArray(value.accounts)) throw 0;
    const accounts: ImportAccount[] = [];
    for (const entry of value.accounts) {
      if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.model !== "string") throw 0;
      accounts.push({ file: await privateJson(resolve(dirname(path), entry.path)), model: entry.model });
    }
    const config = { ...value, accounts } as unknown as ImportConfig;
    validateImport(config);
    return config;
  } catch { throw new ImportFailure("inputs"); }
}
