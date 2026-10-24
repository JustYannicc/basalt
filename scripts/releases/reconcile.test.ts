import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { makeReleaseRoot, releases, sha } from "./fixtures.test-helpers.ts";
import { GitHubApi } from "./github.ts";
import { reconcileReleasePullRequest, type ReleasePullRequest } from "./reconcile.ts";
import { applyUpdatePlan, planUpdate } from "./update.ts";

test("creates a public-safe failing candidate and keeps identical scheduled retries idempotent", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Release fixture"]);
  git(root, ["config", "user.email", "release-fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture baseline"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "--detach", base]);

  let pull: ReleasePullRequest | undefined;
  let pushedHead = "";
  const labels = new Set<string>();
  const statuses: Array<{ head: string; state: string; description: string }> = [];
  const repository = "owner/repository";
  const branch = "release-updates/node-v8.0.41";
  const api = {
    async get(path: string) {
      if (path === "repos/router-for-me/CLIProxyAPI/releases/latest") return releases("node", "8.0.41", "4");
      if (path === "repos/router-for-me/CLIProxyAPI/commits/v8.0.41") return { sha: sha("e") };
      if (path.includes("/pulls?state=all")) return pull ? [structuredClone(pull)] : [];
      if (path === `repos/${repository}/commits/${encodeURIComponent(branch)}`) throw missing();
      if (path.startsWith(`repos/${repository}/labels/`)) {
        const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        if (!labels.has(name)) throw missing();
        return { name };
      }
      if (path === `repos/${repository}/pulls/41`) {
        if (!pull) throw missing();
        return structuredClone(pull);
      }
      if (path.startsWith(`repos/${repository}/commits/`)) {
        const ref = decodeURIComponent(path.slice(`repos/${repository}/commits/`.length));
        try {
          const parents = git(root, ["show", "-s", "--format=%P", ref]).trim().split(" ").filter(Boolean).map((sha) => ({ sha }));
          const tree = git(root, ["show", "-s", "--format=%T", ref]).trim();
          return { parents, commit: { tree: { sha: tree } } };
        } catch {
          throw missing();
        }
      }
      if (path.startsWith(`repos/${repository}/compare/`)) return { merge_base_commit: { sha: base } };
      if (path.startsWith(`repos/${repository}/contents/`)) {
        const [encodedFile, encodedRef] = path.slice(`repos/${repository}/contents/`.length).split("?ref=");
        const filename = encodedFile!.split("/").map(decodeURIComponent).join("/");
        const ref = decodeURIComponent(encodedRef!);
        try {
          const content = git(root, ["show", `${ref}:${filename}`]);
          return { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") };
        } catch {
          throw missing();
        }
      }
      throw new Error(`Unexpected mocked request: ${path}`);
    },
    async request(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
      if (method === "POST" && path === `repos/${repository}/labels`) {
        labels.add((body as { name: string }).name);
        return undefined;
      }
      if (method === "POST" && path === `repos/${repository}/pulls`) {
        const input = body as { title: string; body: string };
        pull = {
          number: 41,
          state: "open",
          title: input.title,
          body: input.body,
          head: { sha: pushedHead, ref: branch, repo: { full_name: repository } },
          base: { sha: base, ref: "main", repo: { full_name: repository } },
          labels: [],
        };
        return structuredClone(pull);
      }
      if (method === "POST" && path === `repos/${repository}/issues/41/labels`) {
        for (const label of (body as { labels: string[] }).labels) {
          labels.add(label);
          pull!.labels.push({ name: label });
        }
        return undefined;
      }
      if (method === "PATCH" && path === `repos/${repository}/pulls/41`) {
        Object.assign(pull!, body);
        return structuredClone(pull);
      }
      const status = new RegExp(`^repos/${repository}/statuses/([a-f0-9]{40})$`).exec(path);
      if (method === "POST" && status) {
        const value = body as { state: string; description: string };
        statuses.push({ head: status[1]!, state: value.state, description: value.description });
        return undefined;
      }
      if (method === "DELETE" && path.startsWith(`repos/${repository}/issues/41/labels/`)) {
        const label = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        pull!.labels = pull!.labels.filter(({ name }) => name !== label);
        return undefined;
      }
      throw new Error(`Unexpected mocked mutation: ${method} ${path}`);
    },
    async compare(repo: string, before: string, after: string) {
      if (repo !== repository) return { complete: true, status: "ahead" as const, aheadBy: 1, behindBy: 0, files: [] };
      const rows = git(root, ["diff", "--name-status", before, after]).trim().split("\n").filter(Boolean);
      const files = rows.map((row) => {
        const [status, filename] = row.split("\t");
        const [additionsText, deletionsText] = git(root, ["diff", "--numstat", before, after, "--", filename!]).trim().split("\t");
        const additions = Number(additionsText);
        const deletions = Number(deletionsText);
        return {
          filename: filename!,
          status: status === "A" ? "added" : status === "D" ? "removed" : "modified",
          additions,
          deletions,
          changes: additions + deletions,
        };
      });
      return { complete: true, status: "ahead" as const, aheadBy: 1, behindBy: 0, mergeBaseSha: before, files };
    },
    async compareTrees(this: Pick<GitHubApi, "compare">, repo: string, before: string, after: string) {
      return this.compare(repo, before, after);
    },
  } as unknown as GitHubApi;

  const plan = await planUpdate(root, "node", api);
  applyUpdatePlan(root, plan);
  let pushCount = 0;
  const pushBranch = (checkout: string, actualBranch: string, previousHead: string | undefined, token: string) => {
    assert.equal(actualBranch, branch);
    assert.equal(previousHead, undefined);
    assert.equal(token, "release-token");
    pushedHead = git(checkout, ["rev-parse", "HEAD"]).trim();
    pushCount++;
  };
  const first = await reconcileReleasePullRequest(
    root, repository, "node", plan, "release-token", "private error /Users/runner/secret", api, { pushBranch },
  );

  assert.equal(first.outcome, "created");
  assert.equal(first.preparationFailed, true);
  assert.ok(pull?.labels.some(({ name }) => name === "release-update"));
  assert.ok(pull?.labels.some(({ name }) => name === "manual-release"));
  assert.doesNotMatch(pull?.body ?? "", /private error|\/Users\/runner\/secret/);
  assert.equal(statuses[0]?.state, "failure");
  assert.doesNotMatch(statuses[0]?.description ?? "", /private error|\/Users\/runner\/secret/);

  git(root, ["checkout", "--detach", base]);
  git(root, ["reset", "--hard", base]);
  const repeatedPlan = await planUpdate(root, "node", api);
  applyUpdatePlan(root, repeatedPlan);
  const repeated = await reconcileReleasePullRequest(
    root, repository, "node", repeatedPlan, "release-token", undefined, api, { pushBranch },
  );

  assert.equal(repeated.outcome, "unchanged");
  assert.equal(repeated.head, first.head);
  assert.equal(pushCount, 1);
  assert.equal(pull?.labels.some(({ name }) => name === "manual-release"), false);
  assert.equal(statuses[1]?.state, "success");
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function missing(): Error & { status: number } {
  return Object.assign(new Error("missing"), { status: 404 });
}
