import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { makeReleaseRoot, patchManifest, releases, sha, writePatchLayout } from "./fixtures.test-helpers.ts";
import { GitHubApi } from "./github.ts";
import { reconcileReleasePullRequest, type ReleasePullRequest } from "./reconcile.ts";
import { applyUpdatePlan, planUpdate } from "./update.ts";

for (const transition of ["none", "open", "orphan"] as const) {
test(`reconciles ${transition === "none" ? "an idempotent current branch" : `a legacy ${transition} branch across format 4 migration`}`, async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  if (transition !== "none") {
    for (const patch of patchManifest.patches) unlinkSync(join(root, "patches", patch.file.replace(/\.patch$/, ".json")));
    writeFileSync(join(root, "scripts/releases/patches.json"), JSON.stringify(patchManifest));
  }
  const source = transition === "none" ? "node" : "tools";
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Release fixture"]);
  git(root, ["config", "user.email", "release-fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture baseline"]);
  let base = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "--detach", base]);

  let pull: ReleasePullRequest | undefined;
  let pushedHead = "";
  const labels = new Set<string>();
  const statuses: Array<{ head: string; state: string; description: string }> = [];
  const repository = "owner/repository";
  const branch = source === "node" ? "release-updates/node-v8.0.41" : "release-updates/tools-executor-2.0.0-beta.27-eeeeeeeeeeee";
  let complete = true;
  const api = {
    async get(path: string) {
      if (path === "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1") return [{ tag_name: "executor@2.0.0-beta.27", draft: false }];
      if (path === "repos/UsefulSoftwareCo/executor/commits/executor%402.0.0-beta.27") return { sha: sha("e") };
      if (path === "repos/UsefulSoftwareCo/executor/contents/apps/hosted/cloud/package.json?ref=executor%402.0.0-beta.27")
        return { encoding: "base64", content: Buffer.from(JSON.stringify({ name: "@executor-js/hosted-cloud" })).toString("base64") };
      if (path === "repos/UsefulSoftwareCo/executor/pulls/10") return { merged: true, merge_commit_sha: sha("f") };
      if (path === "repos/UsefulSoftwareCo/executor/pulls/14") return { merged: false, merge_commit_sha: null };
      if (path === "repos/router-for-me/CLIProxyAPI/releases/latest") return releases("node", "8.0.41", "4");
      if (path === "repos/router-for-me/CLIProxyAPI/commits/v8.0.41") return { sha: sha("e") };
      if (path.includes("/pulls?state=all")) return pull ? [structuredClone(pull)] : [];
      if (path === `repos/${repository}/commits/${encodeURIComponent(branch)}`) {
        if (pushedHead) return { sha: pushedHead };
        throw missing();
      }
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
      return { complete, status: "ahead" as const, aheadBy: 1, behindBy: 0, mergeBaseSha: before, files };
    },
    async compareTrees(this: Pick<GitHubApi, "compare">, repo: string, before: string, after: string) {
      return this.compare(repo, before, after);
    },
  } as unknown as GitHubApi;

  const plan = await planUpdate(root, source, api);
  applyUpdatePlan(root, plan);
  let pushCount = 0;
  const pushBranch = (checkout: string, actualBranch: string, previousHead: string | undefined, token: string) => {
    assert.equal(actualBranch, branch);
    assert.equal(previousHead, pushCount === 0 ? undefined : pushedHead);
    assert.equal(token, "release-token");
    pushedHead = git(checkout, ["rev-parse", "HEAD"]).trim();
    if (pull) { pull.head.sha = pushedHead; pull.base.sha = base; }
    pushCount++;
  };
  const first = await reconcileReleasePullRequest(
    root, repository, source, plan, "release-token", "private error /Users/runner/secret", api, { pushBranch },
  );

  assert.equal(first.outcome, "created");
  assert.equal(pull?.title, source === "node" ? "chore: update node to node-v8.0.41" : "chore: update tools to tools-executor-2.0.0-beta.27-eeeeeeeeeeee");
  assert.equal(first.preparationFailed, true);
  assert.ok(pull?.labels.some(({ name }) => name === "release-update"));
  assert.ok(pull?.labels.some(({ name }) => name === "manual-release"));
  assert.doesNotMatch(pull?.body ?? "", /private error|\/Users\/runner\/secret/);
  assert.equal(statuses[0]?.state, "failure");
  assert.doesNotMatch(statuses[0]?.description ?? "", /private error|\/Users\/runner\/secret/);

  git(root, ["checkout", "--detach", base]);
  git(root, ["reset", "--hard", base]);
  if (transition !== "none") {
    writePatchLayout(root, patchManifest);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "migrate registry"]);
    base = git(root, ["rev-parse", "HEAD"]).trim();
    if (transition === "orphan") pull = undefined;
  }
  const repeatedPlan = await planUpdate(root, source, api);
  applyUpdatePlan(root, repeatedPlan);
  if (transition !== "none") {
    complete = false;
    await assert.rejects(reconcileReleasePullRequest(root, repository, source, repeatedPlan, "release-token", undefined, api, { pushBranch }), /incomplete/);
    assert.equal(pushCount, 1);
    complete = true;
  }
  const repeated = await reconcileReleasePullRequest(
    root, repository, source, repeatedPlan, "release-token", undefined, api, { pushBranch },
  );

  assert.equal(repeated.outcome, transition === "none" ? "unchanged" : transition === "open" ? "updated" : "created");
  if (transition === "none") assert.equal(repeated.head, first.head);
  else {
    assert.notEqual(repeated.head, first.head);
    assert.equal(JSON.parse(readFileSync(join(root, "scripts/releases/patches.json"), "utf8")).format_version, 4);
    assert.equal(readFileSync(join(root, "patches/0004-workflow.json"), "utf8"), `${JSON.stringify(patchManifest.patches[1], null, 2)}\n`);
  }
  assert.equal(pushCount, transition === "none" ? 1 : 2);
  assert.equal(pull?.labels.some(({ name }) => name === "manual-release"), false);
  assert.equal(statuses[1]?.state, "success");
});
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function missing(): Error & { status: number } {
  return Object.assign(new Error("missing"), { status: 404 });
}
