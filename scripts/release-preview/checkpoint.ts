import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describeError, redactor } from "./redact.ts";
import { pathToFileURL } from "node:url";
import { openManifest, sealManifest } from "./manifest.ts";
import { parseSubjectArgument, stageNames, toSubject, type StageSubject } from "../preview/subject.ts";

export function previewNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("An exact preview PR number is required");
  }
  return Number(value);
}

export function manifestPath(root: string, owner: number | StageSubject): string {
  return join(root, ".local", "previews", `${stageNames(owner).slug}.json`);
}

function ownsManifest(value: Record<string, unknown>, subject: StageSubject): boolean {
  if (value.version !== 1) return false;
  if (subject.kind === "pr") return (value.pullRequest ?? value.pr) === subject.number;
  return value.rehearsal === subject.number && value.pullRequest === undefined && value.pr === undefined;
}

export async function checkpoint(
  mode: "seal" | "restore", root: string, encryptedPath: string, key: string, owner: number | StageSubject,
): Promise<void> {
  const subject = toSubject(owner);
  const path = manifestPath(root, subject);
  if (mode === "seal") {
    const bytes = await readFile(path);
    const ciphertext = sealManifest(bytes, key, subject);
    await mkdir(dirname(encryptedPath), { recursive: true, mode: 0o700 });
    await writeFile(encryptedPath, ciphertext, { mode: 0o600 });
  } else {
    const bytes = openManifest(await readFile(encryptedPath), key, subject);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!ownsManifest(value, subject)) {
      throw new Error(`Preview cleanup manifest belongs to a different ${subject.kind === "pr" ? "PR" : "rehearsal"}`);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, owner, destination] = process.argv.slice(2);
    if ((mode !== "seal" && mode !== "restore") || !destination) {
      throw new Error("Usage: checkpoint.ts seal|restore PR|rehearsal-N encrypted-file");
    }
    await checkpoint(mode, process.cwd(), resolve(destination), process.env.PREVIEW_STATE_KEY ?? "", parseSubjectArgument(owner));
    console.log(`Preview cleanup checkpoint ${mode === "seal" ? "encrypted" : "restored"}`);
  } catch (error) {
    console.error(describeError(error, redactor(process.env)));
    console.error("Preview cleanup checkpoint failed");
    process.exitCode = 1;
  }
}
