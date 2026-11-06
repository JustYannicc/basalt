import { constants } from "node:fs";
import { lstat, open, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectorDiagnostic } from "./connector-diagnostics.mjs";

const jobs = {
  "gitlab-connectors": ["connectors-proof"],
  "slack-health": ["slack-health"],
  "vercel-sign-in": ["vercel-sign-in"],
  "elevenlabs-sign-in": ["elevenlabs-sign-in"],
  "catalog-compat": ["catalog-compat", "elevenlabs-discovery"],
};
const files = {
  "upstream-head.json": "source-check",
  "install.json": "install",
  "zendesk-tenant-runtime.json": "zendesk-tenant",
  "runtime.json": "runtime",
  "report.json": "report",
  "result.json": "report",
  "partial-results.json": "partial-report",
  "failure.txt": "failure",
};

async function directory(path) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function diagnostic(path, stage) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { stage, input: "omitted" };
    if (info.size > 1024 * 1024) return { stage, input: "too-large" };
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) return { stage, input: "too-large" };
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    if (stage === "failure") return connectorDiagnostic(stage, text, true);
    try {
      return connectorDiagnostic(stage, JSON.parse(text), stage === "partial-report");
    } catch {
      return { stage, input: "malformed" };
    }
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (["EACCES", "EPERM", "ELOOP"].includes(error.code)) return { stage, input: "unreadable" };
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Only known proof files feed closed-field summaries; runtime trees and screenshots stay private. */
export async function collectConnectorEvidence(root, job) {
  if (!Object.hasOwn(jobs, job)) throw new Error("Unknown connector proof job");
  const runs = [];
  let truncated = false;
  if ((await directory(root)) && (await directory(join(root, ".generated")))) {
    for (const source of jobs[job]) {
      const base = join(root, ".generated", source);
      if (!(await directory(base))) continue;
      const candidates =
        source === "connectors-proof"
          ? (await readdir(base)).filter((name) => /^run-[A-Za-z0-9]+$/.test(name)).sort()
          : ["ci"];
      truncated ||= candidates.length > 8;
      for (const name of candidates.slice(0, 8)) {
        const run = join(base, name);
        if (!(await directory(run))) continue;
        const records = [];
        for (const [file, stage] of Object.entries(files)) {
          const record = await diagnostic(join(run, file), stage);
          if (record) records.push(record);
        }
        if (records.length) runs.push({ source, records });
      }
    }
  }
  return { version: 1, job, truncated, status: runs.length ? "recorded" : "no-evidence", runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [job, output] = process.argv.slice(2);
  if (!job || !output) throw new Error("Expected a connector job and sanitized output file");
  const summary = await collectConnectorEvidence(process.cwd(), job);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`Connector evidence: ${summary.runs.length} bounded summaries, ${summary.status}`);
}
