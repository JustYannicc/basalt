import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openManifest, sealManifest } from "./manifest.ts";

export function previewNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("An exact preview PR number is required");
  }
  return Number(value);
}

export function manifestPath(root: string, pullRequest: number): string {
  return join(root, ".local", "previews", `pr-${pullRequest}.json`);
}

export async function checkpoint(
  mode: "seal" | "restore", root: string, encryptedPath: string, key: string, pullRequest: number,
): Promise<void> {
  const path = manifestPath(root, pullRequest);
  if (mode === "seal") {
    const bytes = await readFile(path);
    const ciphertext = sealManifest(bytes, key, pullRequest);
    await mkdir(dirname(encryptedPath), { recursive: true, mode: 0o700 });
    await writeFile(encryptedPath, ciphertext, { mode: 0o600 });
  } else {
    const bytes = openManifest(await readFile(encryptedPath), key, pullRequest);
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.version !== 1 || (value.pullRequest ?? value.pr) !== pullRequest) {
      throw new Error("Preview cleanup manifest belongs to a different PR");
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, number, destination] = process.argv.slice(2);
    if ((mode !== "seal" && mode !== "restore") || !destination) {
      throw new Error("Usage: checkpoint.ts seal|restore PR encrypted-file");
    }
    await checkpoint(mode, process.cwd(), resolve(destination), process.env.PREVIEW_STATE_KEY ?? "", previewNumber(number));
    console.log(`Preview cleanup checkpoint ${mode === "seal" ? "encrypted" : "restored"}`);
  } catch {
    console.error("Preview cleanup checkpoint failed");
    process.exitCode = 1;
  }
}
