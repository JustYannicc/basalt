import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { canonical, digest } from "../release-barrier/manifest.ts";
import { recoverWorkers } from "../release-barrier/recovery.ts";

const candidate = "a".repeat(40),
  baseline = "b".repeat(40);
const artifactPin = {
  tag: "v1",
  commit: baseline,
  binary: "fixture",
  assets: {
    amd64: { name: "amd64", sha256: "c".repeat(64) },
    arm64: { name: "arm64", sha256: "d".repeat(64) },
  },
};
const pins = { tools: { commit: baseline }, home: artifactPin, node: artifactPin };

export function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "recorded-recovery-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const workers = ["Api", "Router", "PoolWorker"].map((id) => ({
    id,
    target: `target-${id}`,
    metadata: "metadata",
    files: [],
    baseline: [{ versionId: `old-${id}`, percentage: 100 }],
  }));
  const manifest = { candidate, stack: "basalt", stage: "production", workers };
  const receipt = {
    schemaVersion: 1,
    candidate,
    manifest: digest(canonical(manifest)),
    accepted: workers.map(({ id }) => ({ worker: id, versionId: `new-${id}`, startupTimeMs: 100 })),
    activated: [{ worker: "Api", versionId: "new-Api" }],
    pending: { worker: "Router", versionId: "new-Router" },
  };
  const payload = {
    system: "basalt-deploy-safety",
    schemaVersion: 1,
    kind: "release",
    gitCommit: candidate,
    candidateGitCommit: candidate,
    baseGitCommit: baseline,
    pins,
    basePins: pins,
    databaseChanged: false,
    workflowChanged: false,
    reportDigest: "e".repeat(64),
    run: { repository: "owner/repo", id: 42, attempt: 1 },
  };
  const active = new Map(workers.map((w) => [w.id, w.baseline]));
  active.set("Api", [{ versionId: "new-Api", percentage: 100 }]);
  active.set("Router", [{ versionId: "new-Router", percentage: 100 }]);
  const restored: string[] = [];
  const prepared: string[] = [];
  const request = {
    candidate,
    sourceRun: "42/1",
    databaseCompatible: false,
    pairSha256: digest(canonical({ manifest, receipt })),
  };
  const run = {
    id: 42,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: candidate,
    path: ".github/workflows/release-main.yml",
    head_repository: { full_name: "owner/repo" },
  };
  const status = { current: "failure" };
  let archive: Buffer;
  let progressArchive: Buffer;
  function zip(includeReceipt = true) {
    const folder = join(directory, "archive");
    const evidence = join(folder, "_temp/candidate/.local/release-barrier");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest));
    if (includeReceipt) writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt));
    const path = join(directory, "artifact.zip");
    execFileSync("zip", ["-qr", path, "_temp"], { cwd: folder });
    archive = readFileSync(path);
  }
  const progress = { candidate, manifest: receipt.manifest, restored: ["Api"], pending: "Router" };
  function progressZip(sourceRun = "42/1") {
    const folder = join(directory, "progress-archive");
    mkdirSync(folder);
    for (const [name, value] of Object.entries({
      manifest,
      receipt,
      recovery: progress,
      source: { candidate, sourceRun, pairSha256: request.pairSha256, repository: "owner/repo" },
    }))
      writeFileSync(join(folder, `${name}.json`), JSON.stringify(value));
    const path = join(directory, "progress.zip");
    execFileSync("zip", ["-qr", path, "."], { cwd: folder });
    progressArchive = readFileSync(path);
  }
  const io = {
    environment: { repository: "owner/repo", token: "fixture-token" },
    directory: join(directory, "recovery"),
    async fetcher(input: string | URL | Request, init?: RequestInit) {
      assert.equal(init?.method ?? "GET", "GET", "recovery must not mutate an API");
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/deployments"))
        return Response.json([
          {
            id: 9,
            sha: candidate,
            environment: "production",
            created_at: "2026-11-15T02:00:00Z",
            payload,
          },
          {
            id: 8,
            sha: baseline,
            environment: "production",
            created_at: "2026-11-15T01:00:00Z",
            payload: {
              ...payload,
              gitCommit: baseline,
              candidateGitCommit: baseline,
              baseGitCommit: "0".repeat(40),
            },
          },
        ]);
      if (path.endsWith("/deployments/9/statuses"))
        return Response.json([
          { id: 91, state: status.current, created_at: "2026-11-15T02:01:00Z" },
        ]);
      if (path.endsWith("/deployments/8/statuses"))
        return Response.json([{ id: 81, state: "success", created_at: "2026-11-15T01:01:00Z" }]);
      if (path.endsWith("/actions/runs/42")) return Response.json(run);
      if (path.endsWith("/actions/runs/43"))
        return Response.json({ ...run, id: 43, path: ".github/workflows/release-rollback.yml" });
      if (path.endsWith("/actions/runs/43/artifacts"))
        return Response.json({
          total_count: 1,
          artifacts: [
            {
              id: 78,
              name: "recorded-version-recovery",
              expired: false,
              digest: `sha256:${digest(progressArchive)}`,
              workflow_run: { id: 43, head_sha: candidate },
            },
          ],
        });
      if (path.endsWith("/actions/runs/42/artifacts"))
        return Response.json({
          total_count: 1,
          artifacts: [
            {
              id: 77,
              name: "release-barrier",
              expired: false,
              digest: `sha256:${digest(archive)}`,
              workflow_run: { id: 42, head_sha: candidate },
            },
          ],
        });
      if (path.endsWith("/actions/artifacts/77/zip")) return new Response(new Uint8Array(archive));
      if (path.endsWith("/actions/artifacts/78/zip"))
        return new Response(new Uint8Array(progressArchive));
      throw new Error(`Unexpected recovery request: ${path}`);
    },
    async prepare(release: string) {
      prepared.push(release);
      assert.equal(release, candidate);
      return directory;
    },
    async execute(_root: string, args: string[], compatible: boolean) {
      assert.deepEqual(args.slice(0, 4), ["run", "deploy", "--", "--recover"]);
      assert.equal(compatible, false);
      await recoverWorkers(
        JSON.parse(readFileSync(args[4]!, "utf8")),
        JSON.parse(readFileSync(args[5]!, "utf8")),
        {
          async read(worker) {
            return { target: worker.target, versions: active.get(worker.id)! };
          },
          async restore(worker) {
            restored.push(worker.id);
            active.set(worker.id, worker.baseline);
          },
        },
        async () => {},
      );
    },
  };
  return {
    request,
    io,
    manifest,
    receipt,
    active,
    workers,
    restored,
    prepared,
    zip,
    payload,
    run,
    status,
    progressZip,
    progress,
  };
}
