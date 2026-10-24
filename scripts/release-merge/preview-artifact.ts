import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_MERGE_POLICY } from "./policy.ts";

const API_ROOT = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_ARTIFACT_BYTES = 1_000_000;

type HeaderFactory = (extra?: HeadersInit) => Headers;

export async function getPreviewReceiptArtifact(
  fetchImpl: typeof fetch,
  headers: HeaderFactory,
  repository: string,
  runId: number,
  artifactName: string,
): Promise<unknown | undefined> {
  const result = await requestJson(fetchImpl, headers, `/repos/${repositoryPath(repository)}/actions/runs/${runId}/artifacts?per_page=${PAGE_SIZE}`) as {
    artifacts?: Array<{ id: number; name: string; expired: boolean }>;
    total_count?: number;
  };
  const artifacts = result.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("GitHub returned an invalid artifact list");
  if ((result.total_count ?? artifacts.length) > artifacts.length) throw new Error("GitHub returned a truncated artifact list");
  const matches = artifacts.filter((artifact) => artifact.name === artifactName && artifact.expired === false);
  if (matches.length !== 1) return undefined;

  const url = `${API_ROOT}/repos/${repositoryPath(repository)}/actions/artifacts/${matches[0]!.id}/zip`;
  const response = await downloadArtifact(fetchImpl, headers, url);
  const bytes = await readLimitedBody(response, MAX_ARTIFACT_BYTES);
  if (bytes.length === 0) throw new Error("Preview receipt artifact size is invalid");
  return readReceiptFromZip(bytes);
}

async function requestJson(fetchImpl: typeof fetch, headers: HeaderFactory, path: string): Promise<unknown> {
  const response = await fetchImpl(`${API_ROOT}${path}`, { headers: headers() });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return await response.json() as unknown;
}

async function downloadArtifact(fetchImpl: typeof fetch, headers: HeaderFactory, url: string): Promise<Response> {
  let response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: headers(),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("GitHub artifact redirect has no location");
    const destination = new URL(location, url);
    if (destination.protocol !== "https:" || destination.username || destination.password)
      throw new Error("GitHub artifact redirect destination is invalid");
    response = await fetchImpl(destination, { method: "GET", redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error("GitHub artifact returned multiple redirects");
  }
  if (!response.ok) throw new Error(`GitHub artifact download returned HTTP ${response.status}`);
  return response;
}

function readReceiptFromZip(bytes: Buffer): unknown {
  const folder = mkdtempSync(join(tmpdir(), "release-preview-receipt-"));
  const zipPath = join(folder, "receipt.zip");
  try {
    writeFileSync(zipPath, bytes, { mode: 0o600 });
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_ARTIFACT_BYTES });
    const entry = RELEASE_MERGE_POLICY.previewReceiptFile;
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (entries.length !== 1 || entries[0] !== entry) throw new Error("Preview artifact must contain only the root receipt file");
    const contents = execFileSync("unzip", ["-p", zipPath, entry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_ARTIFACT_BYTES });
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Preview receipt artifact is invalid");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Preview receipt artifact size is invalid");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function repositoryPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}
