import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/deploy.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");
const gate = workflow.match(/^    if: >-\n((?:      [^\n]+\n)+)/m)?.[1];

function gateTerms(): string[] {
  assert.ok(gate, "deploy job must have a multiline event guard");
  return gate.split(/\s*&&\s*/).map((term) => term.trim()).filter(Boolean);
}

test("production deploy starts only after the main Check workflow completes", () => {
  assert.match(workflow, /^  workflow_run:\n    workflows: \[Check\]\n    types: \[completed\]\n    branches: \[main\]$/m);
  assert.doesNotMatch(workflow, /^  (?:push|workflow_dispatch):/m);
});

test("failed Check runs cannot satisfy the production deploy gate", () => {
  assert.ok(gateTerms().includes("github.event.workflow_run.conclusion == 'success'"));
});

test("non-push Check runs cannot satisfy the production deploy gate", () => {
  assert.ok(gateTerms().includes("github.event.workflow_run.event == 'push'"));
});

test("Check runs for another branch cannot satisfy the production deploy gate", () => {
  assert.ok(gateTerms().includes("github.event.workflow_run.head_branch == 'main'"));
});

test("runs from another repository or workflow file cannot satisfy the production deploy gate", () => {
  const terms = gateTerms();
  assert.ok(terms.includes("github.event.repository.full_name == github.repository"));
  assert.ok(terms.includes("github.event.workflow_run.head_repository.full_name == github.repository"));
  assert.ok(terms.includes("github.event.workflow_run.path == '.github/workflows/ci.yml'"));
  assert.ok(terms.includes("github.event.workflow_run.name == 'Check'"));
});

test("checkout, report and deploy all use the exact successful Check SHA", () => {
  assert.match(workflow, /^          ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m);
  assert.match(workflow, /^      RELEASE_CANDIDATE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m);
  assert.match(workflow, /release\.ts report --candidate "\$RELEASE_CANDIDATE_SHA"/);
  assert.match(workflow, /env -u GITHUB_SHA node scripts\/deploy-safety\/release\.ts deploy --candidate "\$RELEASE_CANDIDATE_SHA"/);
  assert.doesNotMatch(workflow, /release\.ts (?:report|deploy) --candidate "\$GITHUB_SHA"/);
});

test("production serialization, credentials, and release report gates remain", () => {
  assert.match(workflow, /^  group: deploy-production$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /^      CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m);
  assert.match(workflow, /^      PLANETSCALE_API_TOKEN: \$\{\{ secrets\.PLANETSCALE_API_TOKEN \}\}$/m);
  assert.match(workflow, /name: Validate credentials/);
  assert.match(workflow, /release\.ts report --candidate "\$RELEASE_CANDIDATE_SHA" > \.local\/production-report\.json/);
  assert.match(workflow, /release\.ts deploy --candidate "\$RELEASE_CANDIDATE_SHA" --report \.local\/production-report\.json --mode automatic/);
});

test("database and Workflow-identity releases go to Manual release of main without anyone dispatching it", () => {
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("\njobs:")), /actions: write/);
  assert.match(workflow, /- name: Compare the candidate with the last successful production deployment\n\s+id: report\n/);
  assert.match(workflow, /- name: Deploy normal releases[^\n]*\n\s+if: steps\.report\.outputs\.manual_required == 'false'\n\s+run: env -u GITHUB_SHA node scripts\/deploy-safety\/release\.ts deploy [^\n]*--mode automatic/);
  assert.match(workflow, /if: steps\.report\.outputs\.manual_required != 'false' && steps\.report\.outputs\.deployable != 'true'\n\s+run: \|\n[^\n]*unresolved[^\n]*\n\s+exit 1/);
  const handoff = workflow.slice(workflow.indexOf("\n  handoff:\n"));
  assert.match(handoff, /^    needs: deploy\n    if: needs\.deploy\.outputs\.manual_required != 'false'$/m);
  assert.match(handoff, /^    permissions:\n      contents: read\n      actions: write$/m);
  assert.doesNotMatch(handoff, /secrets\.|actions\/checkout|npm |node /);
  assert.match(workflow, /^      manual_required: \$\{\{ steps\.report\.outputs\.manual_required \}\}$/m);
});

test("the handoff releases this Check's commit even when main has moved on", () => {
  const handoff = workflow.slice(workflow.indexOf("\n  handoff:\n"));
  const script = handoff.match(/^        run: \|\n((?:          [^\n]*\n?)+)/m)?.[1];
  assert.ok(script, "handoff must run a script");
  // A newer head, or its pending or failed Check, no longer defers or blocks this release.
  assert.doesNotMatch(script, /commits\/main|ci\.yml\/runs|exit 0/);
  assert.match(script, /^          if gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$RELEASE_CANDIDATE_SHA\/pulls" --jq '\.\[\]\.head\.ref' \| grep -q '\^release-updates\/'; then\n[^\n]*::error::[^\n]*\n\s+exit 1\n\s+fi\n/m);
  assert.match(script, /\n          gh workflow run release-main\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f candidate="\$RELEASE_CANDIDATE_SHA"\n?$/);
  assert.equal(script.match(/gh workflow run/g)?.length, 1);
  assert.match(handoff, /^      RELEASE_CANDIDATE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m);
});

test("Manual release of main releases a dispatched candidate main contains, and never one production already has", () => {
  const release = readFileSync(fileURLToPath(new URL("../../.github/workflows/release-main.yml", import.meta.url)), "utf8");
  const backup = release.slice(release.indexOf("\n  backup:\n"), release.indexOf("\n  deploy:\n"));
  const deploy = release.slice(release.indexOf("\n  deploy:\n"));
  assert.match(release, /^  workflow_dispatch:\n    inputs:\n      candidate:\n        description: [^\n]+\n        required: false\n        type: string$/m);
  assert.match(release, /^  group: deploy-production\n  cancel-in-progress: false$/m);
  // Trusted scripts come from main, the same commit in both jobs; the candidate only goes into its own worktree.
  assert.match(backup, /^          ref: main$/m);
  assert.match(backup, /^      trusted: \$\{\{ steps\.trusted\.outputs\.commit \}\}$/m);
  assert.match(backup, /\n\s+id: trusted\n\s+run: echo "commit=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"\n/);
  assert.ok(backup.indexOf("id: trusted") < backup.indexOf("id: candidate"));
  assert.match(deploy, /^          ref: \$\{\{ needs\.backup\.outputs\.trusted \}\}$/m);
  assert.doesNotMatch(deploy, /^          ref: main$/m);
  assert.match(backup, /run: MAIN_RELEASE_CHECKOUT="\$\(git rev-parse HEAD\)" node scripts\/release-merge\/main-candidate\.ts\n\s+env:\n\s+MAIN_RELEASE_CANDIDATE: \$\{\{ inputs\.candidate \}\}\n/);
  assert.doesNotMatch(release, /\$\{\{ inputs\.candidate \}\}"|run: [^\n]*inputs\.candidate/);
  assert.match(backup, /^      already_live: \$\{\{ steps\.live\.outputs\.already_live \}\}$/m);
  assert.match(backup, /\n\s+id: live\n\s+run: node scripts\/deploy-safety\/release\.ts already-live --candidate "\$RELEASE_HEAD"\n/);
  const guarded = backup.slice(backup.indexOf("id: live"));
  assert.ok(backup.indexOf("id: live") > backup.indexOf("id: candidate"));
  // Nothing after the guard runs once production has the candidate: no worktree, report, backup or artifact.
  const steps = guarded.split(/\n      - /).slice(1);
  assert.equal(steps.length, 4);
  for (const step of steps) assert.match(step, /^(?:name: [^\n]+\n        )?if: steps\.live\.outputs\.already_live == 'false'\n/, step);
  assert.match(deploy, /^    if: github\.ref == 'refs\/heads\/main' && needs\.backup\.outputs\.already_live == 'false'$/m);
  // The deploy job only needs main to still contain the backed-up candidate, not to equal it.
  assert.match(deploy, /run: node scripts\/release-merge\/main-candidate\.ts\n\s+env:\n\s+MAIN_RELEASE_CANDIDATE: \$\{\{ needs\.backup\.outputs\.head \}\}\n\s+MAIN_RELEASE_REQUIRE_CANDIDATE: "true"\n/);
  assert.doesNotMatch(release, /MAIN_RELEASE_EXPECTED_HEAD|MAIN_RELEASE_REQUIRE_EXPECTED/);
});
