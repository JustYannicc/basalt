import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "1.7.12";
const installed = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
if (installed.status === 0 && installed.stdout.split("\n")[0] === version) {
  const result = spawnSync("actionlint", [], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  const releases: Record<string, { platform: string; sha256: string }> = {
    "linux/x64": {
      platform: "linux_amd64",
      sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    },
    "linux/arm64": {
      platform: "linux_arm64",
      sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    },
    "darwin/x64": {
      platform: "darwin_amd64",
      sha256: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    },
    "darwin/arm64": {
      platform: "darwin_arm64",
      sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    },
  };
  const release = releases[`${process.platform}/${process.arch}`];
  if (!release)
    throw new Error("Install actionlint 1.7.12 for this platform before running CI fast locally");
  const temporary = mkdtempSync(join(tmpdir(), "basalt-actionlint-"));
  try {
    const archive = join(temporary, "actionlint.tar.gz");
    execFileSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "120",
        `https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${release.platform}.tar.gz`,
        "--output",
        archive,
      ],
      { stdio: "inherit" },
    );
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== release.sha256)
      throw new Error("Actionlint archive checksum does not match the pinned release");
    execFileSync("tar", ["-xzf", archive, "-C", temporary, "actionlint"]);
    const result = spawnSync(join(temporary, "actionlint"), [], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
