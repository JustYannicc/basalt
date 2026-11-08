import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "./verified-download.ts";

export const actionlintVersion = "1.7.12";
export const actionlintSource = {
  url: "https://proxy.golang.org/github.com/rhysd/actionlint/@v/v1.7.12.zip",
  sha256: "d954c3f877cc5b98a10852bbb642c49758948d9527f1b588a544b6309d336ec2",
};
export const actionlintCache = () =>
  join(
    process.env.RUNNER_TEMP ?? join(homedir(), ".cache/basalt/ci"),
    "actionlint",
    `${actionlintVersion}-${process.platform}-${process.arch}`,
  );
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function ensureActionlint(root = actionlintCache()) {
  mkdirSync(root, { recursive: true });
  const archive = join(root, "source.zip");
  downloadVerified(
    actionlintSource.url,
    "sha256-" + Buffer.from(actionlintSource.sha256, "hex").toString("base64"),
    archive,
  );
  const binary = join(root, process.platform === "win32" ? "actionlint.exe" : "actionlint");
  const receipt = join(root, "binary.sha256");
  if (existsSync(binary) && existsSync(receipt)) {
    if (digest(binary) !== readFileSync(receipt, "utf8"))
      throw new Error("Cached actionlint binary checksum mismatch");
    console.log(`Verified actionlint ${actionlintVersion} binary cache hit`);
    return binary;
  }
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  try {
    execFileSync("unzip", ["-q", archive, "-d", source]);
    execFileSync(
      "go",
      [
        "build",
        "-mod=readonly",
        "-trimpath",
        "-ldflags",
        `-X github.com/rhysd/actionlint.version=${actionlintVersion}`,
        "-o",
        binary,
        "./cmd/actionlint",
      ],
      {
        cwd: join(source, `github.com/rhysd/actionlint@v${actionlintVersion}`),
        stdio: "inherit",
        env: {
          ...process.env,
          GOPROXY: "https://proxy.golang.org",
          GOSUMDB: "sum.golang.org",
          GONOPROXY: "none",
          GONOSUMDB: "none",
          GOTOOLCHAIN: "go1.25.0",
        },
      },
    );
    const version = execFileSync(binary, ["-version"], { encoding: "utf8" }).split("\n")[0];
    if (version !== actionlintVersion) throw new Error(`Unexpected actionlint version ${version}`);
    writeFileSync(receipt, digest(binary));
    return binary;
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "identify" && process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `key=actionlint-source-v1-${actionlintVersion}-${process.platform}-${process.arch}-${actionlintSource.sha256}\npath=${actionlintCache()}\n`,
    );
  else if (process.argv[2] === "install") {
    const binary = ensureActionlint();
    if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, actionlintCache() + "\n");
    console.log(`Checksum-verified actionlint ready: ${binary}`);
  } else throw new Error("Expected identify or install");
}
