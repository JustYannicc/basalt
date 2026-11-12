import { servedFrameworkVersion } from "../framework-release.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyConnectorsSource } from "./connectors-source.ts";
import { poolWorkerRevisionPath, poolWorkerRevisionSource } from "./pool-worker-revision.ts";
import {
  obsidianPluginVersionPath,
  obsidianPluginVersionSource,
} from "./obsidian-plugin-version.ts";
import { bundlePoolApp } from "./pool-app-bundle.ts";
import { prepareTestPlans } from "./ci/declarations.ts";
import { prepareE2e } from "./ci/prepare-e2e.ts";

function verifyFixture(declaredPlans: boolean) {
  const root = mkdtempSync(join(tmpdir(), "connectors-source-test-"));
  const upstream = join(root, ".upstream");
  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const initialize = (cwd: string) => {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Source verification test");
    git(cwd, "config", "user.email", "source@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "Source fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  try {
    for (const [path, content] of Object.entries({
      ".upstream/.gitignore": "**/.generated/\n",
      ".upstream/packages/apps/package.json": JSON.stringify({ version: servedFrameworkVersion }),
      ".upstream/packages/example.ts": "export const carried = false;\n",
      ".upstream/packages/ui/src/implementation/styles/fonts/geist-sans.woff2": "sans",
      ".upstream/packages/ui/src/implementation/styles/fonts/geist-mono.woff2": "mono",
      ".upstream/packages/ui/src/implementation/styles/fonts/LICENSE.txt": "license",
    }))
      write(path, content);
    const inventorySource = ".upstream/e2e/tests/hitl-intent-scope.spec.ts";
    const observerSource = ".upstream/e2e/support/document-requests.ts";
    if (declaredPlans) write(inventorySource, "export const documentScoped = false;\n");
    const pin = initialize(upstream);
    write(".upstream/packages/example.ts", "export const carried = true;\n");
    const requiredSource = ".upstream/packages/required.ts";
    write(requiredSource, "export const required = true;\n");
    if (declaredPlans) {
      write(".upstream/e2e/basalt-plans.json", "{}\n");
      write(".upstream/e2e/tests/tool-policy-draft.spec.ts", "export {};\n");
    }
    git(upstream, "add", "-N", ".");
    write("patches/0001-example.patch", git(upstream, "diff") + "\n");
    git(upstream, "reset", "--mixed", pin);
    const native = "export const nativeControlPrefix = 'sbn1';\n";
    for (const [path, content] of Object.entries({
      ".gitignore": ".upstream/\n",
      "upstream.json": JSON.stringify({ commit: pin }),
      "apps/pool/index.ts": "export default {};\n",
      "src/pool/token.ts": "export const signer = true;\n",
      "src/pool/access-contract.ts": "export const accessPrefix = 'sba1';\n",
      "src/pool/native-contract.ts": native,
      "src/pool/providers.json": "[]",
      "src/pool/account-acquisition-contract.ts":
        "export const accountAcquisitionPrefix = 'sbas1';\n",
      "src/pool/provider-accounts/cloudflare-scopes.ts":
        "export const cloudflareOAuthScopes = [];\n",
      "src/pool/provider-accounts/definitions.ts": "export const providers = {};\n",
      "src/pool/provider-accounts/capabilities.ts": "export const providerCapabilities = [];\n",
      "src/pool/worker.ts": "export default {};\n",
    }))
      write(path, content);
    if (declaredPlans) {
      write("scripts/ci/inherited-tests.json", JSON.stringify({ manualTargets: {} }));
      write("scripts/ci/e2e-groups.json", "{}");
      write(
        "e2e/plans/example.spec.ts.json",
        JSON.stringify({
          scenarios: {},
          runs: {},
          config: [{ job: "fast", config: "example.config.ts" }],
        }),
      );
      write(inventorySource, "export const documentScoped = true;\n");
      write(observerSource, "export const observeDocument = true;\n");
      git(upstream, "add", "-N", "e2e/support/document-requests.ts");
      write(
        "e2e/hitl-inventory-lifetime.patch",
        git(
          upstream,
          "diff",
          "--",
          "e2e/tests/hitl-intent-scope.spec.ts",
          "e2e/support/document-requests.ts",
        ) + "\n",
      );
      write(
        "e2e/webhook-removal-recovery.patch",
        "diff --git a/e2e/support/webhook-removal-case.ts b/e2e/support/webhook-removal-case.ts\n" +
          "new file mode 100644\n--- /dev/null\n+++ b/e2e/support/webhook-removal-case.ts\n" +
          "@@ -0,0 +1 @@\n+export const orderedRecovery = true;\n",
      );
      write(inventorySource, "export const documentScoped = false;\n");
      rmSync(join(root, observerSource));
      prepareTestPlans(root, join(root, "plans-only"));
      prepareE2e(root, upstream);
      prepareE2e(root, upstream);
      prepareTestPlans(root, upstream);
    }
    const release = initialize(root);
    bundlePoolApp(root, upstream);
    write(
      ".upstream/apps/hosted/server/src/implementation/catalog-app-release.ts",
      `// Generated by Basalt's upstream preparation.\nexport const catalogAppRelease = ${JSON.stringify(release)};\n`,
    );
    const opsRelease = ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
    const opsSource = `// Generated by Basalt's upstream preparation.\nexport const productionOpsRelease = ${JSON.stringify(release)};\n`;
    write(opsRelease, opsSource);
    const revision = `.upstream/${poolWorkerRevisionPath}`;
    write(revision, poolWorkerRevisionSource(root));
    write("clients/obsidian/manifest.json", JSON.stringify({ version: "0.2.0" }));
    const pluginVersion = `.upstream/${obsidianPluginVersionPath}`;
    write(pluginVersion, obsidianPluginVersionSource(root));

    assert.deepEqual(verifyConnectorsSource(root), {
      commit: pin,
      patches: ["0001-example.patch"],
    });
    if (declaredPlans) {
      write(inventorySource, "export const documentScoped = false;\n");
      assert.throws(() => verifyConnectorsSource(root), /differs from the carried patch set/);
      write(inventorySource, "export const documentScoped = true;\n");
      rmSync(join(root, observerSource));
      assert.throws(() => verifyConnectorsSource(root));
      write(observerSource, "export const observeDocument = true;\n");
    }
    rmSync(join(root, requiredSource));
    assert.throws(() => verifyConnectorsSource(root));
    write(requiredSource, "export const required = true;\n");
    if (declaredPlans) {
      write(".upstream/e2e/tests/tool-policy-draft.spec.ts", "export {};\n");
      assert.throws(() => verifyConnectorsSource(root));
      rmSync(join(upstream, "e2e/tests/tool-policy-draft.spec.ts"));
    }
    write(opsRelease, opsSource.replace(release, "0".repeat(40)));
    assert.throws(() => verifyConnectorsSource(root), /Generated production ops release differs/);
    write(opsRelease, opsSource + "export const substituted = true;\n");
    assert.throws(() => verifyConnectorsSource(root), /Generated production ops release differs/);
    write(opsRelease, opsSource);
    write(
      revision,
      poolWorkerRevisionSource(root).replace(/"[a-f0-9]{64}"/, `"${"0".repeat(64)}"`),
    );
    assert.throws(() => verifyConnectorsSource(root), /Generated pool Worker revision differs/);
    write(revision, poolWorkerRevisionSource(root));
    write(pluginVersion, obsidianPluginVersionSource(root).replace("0.2.0", "9.9.9"));
    assert.throws(() => verifyConnectorsSource(root), /Generated Obsidian plugin version differs/);
    write(pluginVersion, obsidianPluginVersionSource(root));
    const extraSource = ".upstream/apps/hosted/cloud/src/implementation/unexpected.ts";
    write(extraSource, "export const unexpected = true;\n");
    assert.throws(
      () => verifyConnectorsSource(root),
      /Unexpected source in the prepared tools runtime: apps\/hosted\/cloud\/src\/implementation\/unexpected\.ts/,
    );
    rmSync(join(root, extraSource));
    const generated = ".upstream/apps/hosted/server/src/implementation/native-contract.ts";
    write(generated, "export const nativeControlPrefix = 'substituted';\n");
    assert.throws(() => verifyConnectorsSource(root), /Generated pool runtime source differs/);
    write(generated, native);
    const generatedDefinitions =
      ".upstream/apps/hosted/server/src/implementation/pool-provider-definitions.ts";
    write(generatedDefinitions, "export const providers = { substituted: true };\n");
    assert.throws(() => verifyConnectorsSource(root), /Generated pool runtime source differs/);
    write(generatedDefinitions, "export const providers = {};\n");
    write("src/pool/native-contract.ts", "export const nativeControlPrefix = 'substituted';\n");
    assert.throws(() => verifyConnectorsSource(root), /Generated pool runtime source differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const declaredPlans of [false, true])
  test(`connector source verification preserves strict source checks${declaredPlans ? " after retiring a carried test" : ""}`, () =>
    verifyFixture(declaredPlans));
