import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../release-barrier/manifest.ts";
import { SafetyGateError } from "./contracts.ts";
import type { LedgerEnvironment } from "./github-ledger.ts";
import { record, requestJson, withBearer, type Fetcher } from "./http.ts";

const maximumBytes = 16 * 1024 * 1024;
const selectedFiles = [
  "manifest.json",
  "receipt.json",
  "container-recovery.sealed.json",
  "recovery.json",
  "source.json",
];

export async function recoveryArtifact(
  environment: LedgerEnvironment,
  fetcher: Fetcher,
  run: number,
  name: string,
  directory: string,
  head: string,
) {
  const api = `https://api.github.com/repos/${environment.repository}`;
  const headers = withBearer(environment.token);
  const listing = record(
    (
      await requestJson(fetcher, "GitHub", `${api}/actions/runs/${run}/artifacts?per_page=100`, {
        headers,
      })
    ).body,
    "recovery artifacts",
  );
  if (!Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length)
    throw new SafetyGateError("Recovery artifact listing is incomplete");
  const matches = listing.artifacts
    .map((value) => record(value, "artifact"))
    .filter((artifact) => artifact.name === name && artifact.expired === false);
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    !artifact ||
    typeof artifact.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
  )
    throw new SafetyGateError(`Recovery needs exactly one digest-verified ${name} artifact`);
  const owner = record(artifact.workflow_run, "artifact run");
  if (owner.id !== run || owner.head_sha !== head)
    throw new SafetyGateError("Recovery artifact belongs to another run or source head");
  let response = await fetcher(`${api}/actions/artifacts/${artifact.id}/zip`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 302) {
    const location = new URL(response.headers.get("location") ?? "", api);
    if (location.protocol !== "https:" || location.username || location.password)
      throw new SafetyGateError("Recovery artifact redirect is invalid");
    response = await fetcher(location, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  }
  if (!response.ok || !response.body)
    throw new SafetyGateError(`Recovery artifact download failed with HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new SafetyGateError("Recovery artifact exceeds 16 MiB");
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  if (`sha256:${digest(archive)}` !== artifact.digest)
    throw new SafetyGateError("Recovery artifact digest differs from GitHub's recorded digest");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const zip = join(directory, "artifact.zip");
  writeFileSync(zip, archive, { mode: 0o600, flag: "wx" });
  try {
    const options = {
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as const,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5000,
    };
    const paths = execFileSync("unzip", ["-Z1", zip], options).trim().split(/\r?\n/);
    if (
      new Set(paths).size !== paths.length ||
      paths.some(
        (path) =>
          !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(path) ||
          path.split("/").some((part) => part === ".." || part === "."),
      )
    )
      throw new SafetyGateError("Recovery artifact paths are ambiguous or unsafe");
    const manifests = paths.filter(
      (path) => path === "manifest.json" || path.endsWith("/.local/release-barrier/manifest.json"),
    );
    if (manifests.length !== 1)
      throw new SafetyGateError("Recovery artifact needs one recorded manifest");
    const prefix = manifests[0]!.slice(0, -"manifest.json".length);
    const files = new Map<string, Buffer>();
    for (const file of selectedFiles) {
      const path = prefix + file;
      if (paths.includes(path))
        files.set(file, Buffer.from(execFileSync("unzip", ["-p", zip, path], options)));
    }
    return { files, artifactId: artifact.id, artifactDigest: artifact.digest };
  } catch (error) {
    if (error instanceof SafetyGateError) throw error;
    throw new SafetyGateError("Recovery artifact ZIP is unreadable");
  }
}
