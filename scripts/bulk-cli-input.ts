import { readFile, stat } from "node:fs/promises";
export class BulkCliError extends Error {}
export const fail = (message: string): never => {
  throw new BulkCliError(message);
};
export async function privateJson(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0)
    return fail("JSON input must be private and bounded");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
