import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { deploymentPayloadFor, type LedgerEnvironment } from "../deploy-safety/github-ledger.ts";
import type { Fetcher } from "../deploy-safety/http.ts";

const sha = (character: string) => character.repeat(40);
const oldToolsPin = "f69c667936e4c02c75f9d7cc79fb750c230839b9";
const cutoverToolsPin = "2f4c398f3906e0570f0e25a16fa3602329baba29";

const releasePins = (toolsCommit: string): ReleasePins => ({
  tools: {
    repository: "https://github.com/UsefulSoftwareCo/executor.git",
    commit: toolsCommit,
  },
  home: {
    repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
    tag: "v1",
    commit: sha("c"),
    binary: "home",
    assets: {
      amd64: { name: "amd64", sha256: "1".repeat(64) },
      arm64: { name: "arm64", sha256: "2".repeat(64) },
    },
  },
  node: {
    repository: "https://github.com/router-for-me/CLIProxyAPI.git",
    tag: "v1",
    commit: sha("d"),
    binary: "node",
    assets: {
      amd64: { name: "amd64", sha256: "3".repeat(64) },
      arm64: { name: "arm64", sha256: "4".repeat(64) },
    },
  },
});

export type ReleasePlanGitFixture = {
  repositoryRoot: string;
  base: { commit: string; pins: ReleasePins };
  candidate: { commit: string; pins: ReleasePins };
  priorReport: ClassificationReport;
};

/** Give classifyCurrentRelease two local commit snapshots without using the product checkout. */
export async function createReleasePlanGitFixture(
  repositoryRoot: string,
): Promise<ReleasePlanGitFixture> {
  await mkdir(join(repositoryRoot, "containers", "pool"), { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);

  const snapshot = async (toolsCommit: string, message: string) => {
    const pins = releasePins(toolsCommit);
    await writeFile(
      join(repositoryRoot, "upstream.json"),
      JSON.stringify({ repository: pins.tools.repository, commit: toolsCommit }),
    );
    await writeFile(
      join(repositoryRoot, "containers", "pool", "releases.json"),
      JSON.stringify({ artifacts: { home: pins.home, node: pins.node } }),
    );
    git(["add", "upstream.json", "containers/pool/releases.json"]);
    git(["commit", "-m", message]);
    return { commit: git(["rev-parse", "HEAD"]), pins };
  };

  const base = await snapshot(oldToolsPin, "base");
  const candidate = await snapshot(cutoverToolsPin, "candidate");
  const priorReport: ClassificationReport = {
    schemaVersion: 1,
    base: { gitCommit: base.commit, pins: base.pins },
    candidate: { gitCommit: base.commit, pins: base.pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: {
      database: { state: "unchanged", sources: [] },
      workflow: { state: "unchanged", sources: [] },
    },
  };
  return { repositoryRoot, base, candidate, priorReport };
}

type FixtureDeployment = {
  id: number;
  sha: string;
  environment: "production";
  payload: unknown;
  created_at: string;
};

type FixtureStatus = { id: number; state: string; created_at: string };

/** The release must create and finish these rows through its real GitHub ledger methods. */
export function createReleaseLedgerFixture(priorReport: ClassificationReport): {
  environment: LedgerEnvironment;
  fetcher: Fetcher;
} {
  const environment: LedgerEnvironment = { repository: "owner/repo", token: "fixture-token" };
  const prior: FixtureDeployment = {
    id: 1,
    sha: priorReport.candidate.gitCommit,
    environment: "production",
    payload: deploymentPayloadFor(priorReport),
    created_at: "2026-11-15T04:00:00Z",
  };
  const deployments: FixtureDeployment[] = [prior];
  const statuses = new Map<number, FixtureStatus[]>([
    [prior.id, [{ id: 10, state: "success", created_at: "2026-11-15T04:01:00Z" }]],
  ]);
  let nextDeploymentId = 2;
  let nextEvent = 2;
  const timestamp = () => `2026-11-15T04:${String(nextEvent++).padStart(2, "0")}:00Z`;

  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.includes("/compare/"))
      return Response.json({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        changed_files: 1,
        files: [{ filename: "apps/hosted/cloud/src/implementation/migrations.ts" }],
      });

    if (url.pathname === "/repos/owner/repo/deployments" && method === "GET")
      return Response.json(deployments);
    if (url.pathname === "/repos/owner/repo/deployments" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const deployment: FixtureDeployment = {
        id: nextDeploymentId++,
        sha: String(body.ref),
        environment: "production",
        payload: body.payload,
        created_at: timestamp(),
      };
      deployments.unshift(deployment);
      statuses.set(deployment.id, []);
      return Response.json(deployment, { status: 201 });
    }

    const match = /\/deployments\/(\d+)(\/statuses)?$/.exec(url.pathname);
    if (!match) throw new Error(`Unexpected release fixture request: ${method} ${url.pathname}`);
    const deploymentId = Number(match[1]);
    const deployment = deployments.find(({ id }) => id === deploymentId);
    if (!deployment) throw new Error(`Unknown fixture deployment ${deploymentId}`);
    if (match[2] && method === "GET") return Response.json(statuses.get(deploymentId) ?? []);
    if (match[2] && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const status: FixtureStatus = {
        id: deploymentId * 100 + (statuses.get(deploymentId)?.length ?? 0) + 1,
        state: String(body.state),
        created_at: timestamp(),
      };
      statuses.set(deploymentId, [status, ...(statuses.get(deploymentId) ?? [])]);
      return Response.json(status, { status: 201 });
    }
    if (method === "GET") return Response.json(deployment);
    throw new Error(`Unexpected release fixture request: ${method} ${url.pathname}`);
  };
  return { environment, fetcher };
}
