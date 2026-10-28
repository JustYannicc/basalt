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
  assert.match(handoff, /^\s+"completed "\*\) echo "::error::[^\n]*"; exit 1 ;;\n\s+\*\) echo "::notice::[^\n]*"; exit 0 ;;$/m);
  assert.doesNotMatch(handoff, /"null null"/);
  assert.match(handoff, /release-updates\/[\s\S]*?exit 1[\s\S]*?gh workflow run release-main\.yml --repo "\$GITHUB_REPOSITORY" --ref main/);
  assert.match(workflow, /^      manual_required: \$\{\{ steps\.report\.outputs\.manual_required \}\}$/m);
});
