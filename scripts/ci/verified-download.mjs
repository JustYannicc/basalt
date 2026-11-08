import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, win32 } from "node:path";

export function verifyArchive(path, integrity) {
  const [algorithm, expected] = integrity.split("-");
  if (algorithm !== "sha256" && algorithm !== "sha512")
    throw new Error("Unsupported archive digest");
  if (createHash(algorithm).update(readFileSync(path)).digest("base64") !== expected)
    throw new Error(`Archive checksum mismatch: ${path}`);
}

export function downloadVerified(url, integrity, path) {
  if (existsSync(path)) {
    verifyArchive(path, integrity);
    console.log(`Verified archive cache hit: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pending`;
  try {
    execFileSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "10",
        "--max-time",
        "120",
        url,
        "--output",
        temporary,
      ],
      { stdio: "inherit" },
    );
    verifyArchive(temporary, integrity);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function archiveTar(platform = process.platform) {
  // PATH may select GNU tar, which treats drive-letter paths as remote hosts.
  return platform === "win32"
    ? win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe")
    : "tar";
}
