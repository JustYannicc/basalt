import { execFileSync } from "node:child_process";

// Production release health, computed from GitHub's own records so nobody types the numbers.
export const limits = { consecutiveFailures: 2, waitingHours: 12, stuckHours: 4 };
// GitHub stamps a pull request merged a few seconds after the merge commit it created, so the
// released commit's own pull requests fall inside this window and count as released.
const mergeStampSlackMs = 60_000;

// A deployment is good once any of its statuses was success (GitHub later marks it inactive).
// One that never finishes counts as failed after `stuckHours`.
export type Deployment = {
  sha: string;
  createdAt: string;
  committedAt: string;
  state: "success" | "failure" | "pending";
};
export type Merge = { number: number; mergedAt: string };
export type Health = {
  lastGood: { sha: string; at: string } | null;
  hoursSinceLastGood: number | null;
  consecutiveFailures: number;
  failingSince: string | null;
  latestFailureAt: string | null;
  unreleasedPullRequests: number;
  oldestUnreleasedMergeAt: string | null;
  waitingHours: number;
  stopTheLine: boolean;
  freeze: boolean;
  blocker: boolean;
};

const hours = (from: string, to: Date) => (to.getTime() - Date.parse(from)) / 3_600_000;
const round = (value: number) => Math.round(value * 10) / 10;

export function lastGoodDeployment(deployments: Deployment[], now: Date): Deployment | undefined {
  return deployments
    .filter((d) => d.state === "success" && Date.parse(d.createdAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function releaseHealth(deployments: Deployment[], merges: Merge[], now: Date): Health {
  const lastGood = lastGoodDeployment(deployments, now);
  const after = lastGood ? Date.parse(lastGood.createdAt) : -Infinity;
  const failures = deployments
    .filter((d) => Date.parse(d.createdAt) > after && Date.parse(d.createdAt) <= now.getTime())
    .filter((d) => d.state === "failure" || hours(d.createdAt, now) >= limits.stuckHours)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // Work merged after the released commit is unreleased, also when the release was a rollback.
  const since = lastGood ? Date.parse(lastGood.committedAt) + mergeStampSlackMs : -Infinity;
  const unreleased = merges
    .filter((m) => Date.parse(m.mergedAt) > since && Date.parse(m.mergedAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const oldest = unreleased[0]?.mergedAt ?? null;
  const waiting = oldest ? hours(oldest, now) : 0;
  const stopTheLine = failures.length >= limits.consecutiveFailures;
  const freeze = waiting >= limits.waitingHours;
  return {
    lastGood: lastGood ? { sha: lastGood.sha, at: lastGood.createdAt } : null,
    hoursSinceLastGood: lastGood ? round(hours(lastGood.createdAt, now)) : null,
    consecutiveFailures: failures.length,
    failingSince: failures[0]?.createdAt ?? null,
    latestFailureAt: failures.at(-1)?.createdAt ?? null,
    unreleasedPullRequests: unreleased.length,
    oldestUnreleasedMergeAt: oldest,
    waitingHours: round(waiting),
    stopTheLine,
    freeze,
    blocker: stopTheLine || freeze,
  };
}

const gh = (args: string[]) =>
  JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
const graphql = (query: string, fields: Record<string, string | undefined>) =>
  gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...Object.entries(fields).flatMap(([key, value]) => (value ? ["-f", `${key}=${value}`] : [])),
  ]).data;

const deploymentsQuery = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    deployments(environments: ["production"], first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { commitOid createdAt commit { committedDate } statuses(first: 20) { nodes { state } } }
    }
  }
}`;

const mergesQuery = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number mergedAt } }
  }
}`;

type DeploymentNode = {
  commitOid: string;
  createdAt: string;
  commit: { committedDate: string } | null;
  statuses: { nodes: { state: string }[] };
};

// Reads newest first and stops at the first good deployment: everything older is history.
export function readDeployments(repository: string): Deployment[] {
  const [owner, name] = repository.split("/");
  const deployments: Deployment[] = [];
  let cursor: string | undefined;
  do {
    const page = graphql(deploymentsQuery, { owner, name, cursor }).repository.deployments;
    for (const node of page.nodes as DeploymentNode[]) {
      const states = node.statuses.nodes.map((status) => status.state);
      const state = states.includes("SUCCESS")
        ? "success"
        : states[0] === "FAILURE" || states[0] === "ERROR"
          ? "failure"
          : "pending";
      const committedAt = node.commit?.committedDate ?? node.createdAt;
      deployments.push({ sha: node.commitOid, createdAt: node.createdAt, committedAt, state });
      if (state === "success") return deployments;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (cursor);
  return deployments;
}

export function readMerges(repository: string, since: string): Merge[] {
  const merges: Merge[] = [];
  const q = `repo:${repository} is:pr is:merged base:main merged:>${since}`;
  let cursor: string | undefined;
  let total = 0;
  do {
    const search = graphql(mergesQuery, { q, cursor }).search;
    total = search.issueCount;
    merges.push(...(search.nodes as Merge[]).filter((node) => node.mergedAt));
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : undefined;
  } while (cursor);
  // GitHub search stops at 1,000 results without saying so.
  if (merges.length < total)
    throw new Error(`Read ${merges.length} of ${total} merged pull requests`);
  return merges;
}

export function readHealth(repository: string, now = new Date()) {
  const deployments = readDeployments(repository);
  const lastGood = lastGoodDeployment(deployments, now);
  const since = lastGood?.committedAt ?? deployments.at(-1)?.createdAt ?? now.toISOString();
  const health = releaseHealth(deployments, readMerges(repository, since), now);
  const unreleasedCommits: number | null = lastGood
    ? gh(["api", `repos/${repository}/compare/${lastGood.sha}...main`, "--jq", "{a: .ahead_by}"]).a
    : null;
  return { ...health, unreleasedCommits };
}

if (import.meta.main) {
  const repository = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? "JustYannicc/basalt";
  console.log(JSON.stringify(readHealth(repository), null, 2));
}
