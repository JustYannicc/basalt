import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  historyJournalActivationMigration,
  historySchemaMigrations,
} from "../../src/pool/model-history/schema.ts";
import { canonical, digest } from "./manifest.ts";
import {
  candidateSourceRoot,
  poolMigrationSources,
  sourceContract,
} from "./migration-activation-source.ts";
import { BarrierRefusal } from "./refusal.ts";

const client = fileURLToPath(new URL("../../", import.meta.url));
const hosted = ".upstream/apps/hosted/server/src/implementation/";
const cli = ".upstream/apps/hosted/cloud/src/migrate.ts";
const revision = "c".repeat(64);
const marker = "\n// present only in the candidate\n";
const own = (path: string) => readFileSync(join(client, path), "utf8");

/** A released checkout: the client's pool migration sources, everything else its own. */
function candidateTree(context: TestContext, drifted?: string) {
  const root = mkdtempSync(join(tmpdir(), "basalt-activation-candidate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const files: Record<string, string> = {
    "scripts/pool-history-operator.ts": `export const operation = "journal-activation";\n// historyJournalActivationPath${marker}`,
    "patches/0560-fixture.patch": `candidate carry${marker}`,
    "patches/0560-fixture.json": `{"candidate":true}\n`,
    ...Object.fromEntries(
      poolMigrationSources.map((path) => [path, own(path) + (path === drifted ? marker : "")]),
    ),
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const untracked: Record<string, string> = {
    [hosted + "change-journal-schema.ts"]: own(hosted + "change-journal-schema.ts") + marker,
    [hosted + "deferred-change-schema.ts"]: own(hosted + "deferred-change-schema.ts") + marker,
    [hosted + "pool-worker-revision.ts"]:
      `// Generated fixture.\nexport const poolWorkerRevision = "${revision}";\n`,
    [cli]: own(cli) + marker,
  };
  for (const [path, content] of Object.entries(untracked)) write(path, content);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("add", "--", ...Object.keys(files));
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    "candidate",
  );
  return { root, candidate: git("rev-parse", "HEAD").trim(), files, untracked };
}

const refusal =
  (reason: string, worker: string, changed: readonly unknown[]) => (error: unknown) => {
    assert.ok(error instanceof BarrierRefusal);
    assert.equal(error.reason, reason);
    assert.equal(error.worker, worker);
    assert.deepEqual(error.delta?.changed, changed);
    return true;
  };
const unavailable = (path: string, old: string, observed: string) =>
  refusal("migration-activation-source-capability", "candidate", [{ path, old, new: observed }]);

test("main's client binds a plan to the candidate's sources, never its own", async (context) => {
  const tree = candidateTree(context);
  const contract = await sourceContract(tree.candidate, tree.root);
  // Stated independently of the client: the digest a client living in the candidate tree computes.
  assert.equal(
    contract.fingerprint,
    digest(
      canonical({
        candidate: tree.candidate,
        sources: [
          ...[
            "scripts/pool-history-operator.ts",
            "src/pool/model-history/schema.ts",
            "patches/0560-fixture.json",
            "patches/0560-fixture.patch",
          ].map((path) => [path, digest(tree.files[path]!)]),
          ["hosted", digest(tree.untracked[hosted + "change-journal-schema.ts"]!)],
          ["hosted-inactive", digest(tree.untracked[hosted + "deferred-change-schema.ts"]!)],
          ["cli", digest(tree.untracked[cli]!)],
          [
            "pool-prepared",
            digest(historySchemaMigrations.flatMap((entry) => entry.statements).join("\n")),
          ],
          ["pool-active", digest(canonical(historyJournalActivationMigration))],
        ],
      }),
    ),
  );
  // The operator and carry above are not the client's own files, so its tree was not what got bound.
  assert.notEqual(
    digest(tree.files["scripts/pool-history-operator.ts"]!),
    digest(own("scripts/pool-history-operator.ts")),
  );
  assert.equal(contract.cloud, join(tree.root, ".upstream/apps/hosted/cloud"));
  assert.equal(contract.poolWorkerRevision, revision);
  assert.deepEqual(
    contract.hosted.active.map((fn) => fn.name),
    ["hosted_flush_changes"],
  );

  // Untracked prepared sources are bound too: a different hosted CLI is a different plan.
  appendFileSync(join(tree.root, cli), "// changed\n");
  assert.notEqual(
    (await sourceContract(tree.candidate, tree.root)).fingerprint,
    contract.fingerprint,
  );
});

test("main's client refuses to describe production with pool migrations the candidate does not have", async (context) => {
  for (const path of ["src/pool/model-history/change-schema.ts", "brand.ts"]) {
    const tree = candidateTree(context, path);
    await assert.rejects(
      sourceContract(tree.candidate, tree.root),
      refusal("migration-activation-tooling-definition-drift", path, [
        { path: "sha256", old: digest(tree.files[path]!), new: digest(own(path)) },
      ]),
    );
  }
});

test("the guarded pool migration sources are exactly what the client's import reads", () => {
  const seen = new Set<string>();
  const pending = [join(client, "src/pool/model-history/schema.ts")];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu,
    )) {
      const target = resolve(dirname(file), specifier!);
      assert.ok(existsSync(target), `${relative(client, file)} imports ${specifier}`);
      pending.push(target);
    }
  }
  assert.deepEqual(
    [...seen].map((file) => relative(client, file).replaceAll("\\", "/")).sort(),
    [...poolMigrationSources].sort(),
  );
});

test("a source root that is not the exact prepared candidate refuses, naming what is wrong", async (context) => {
  const tree = candidateTree(context);
  const other = "d".repeat(40);
  await assert.rejects(
    sourceContract(other, tree.root),
    refusal("migration-activation-source-capability", "candidate", [
      { path: "HEAD", old: other, new: tree.candidate },
    ]),
  );
  await assert.rejects(
    sourceContract(tree.candidate, join(tree.root, "missing")),
    unavailable("HEAD", tree.candidate, "unavailable"),
  );
  const revisionFile = join(tree.root, hosted + "pool-worker-revision.ts");
  writeFileSync(revisionFile, `export const poolWorkerRevision = "not-a-revision";\n`);
  await assert.rejects(
    sourceContract(tree.candidate, tree.root),
    unavailable(hosted + "pool-worker-revision.ts", "64-hex revision", "unreadable"),
  );
  rmSync(revisionFile);
  await assert.rejects(
    sourceContract(tree.candidate, tree.root),
    unavailable(hosted + "pool-worker-revision.ts", "prepared", "missing"),
  );
  writeFileSync(revisionFile, tree.untracked[hosted + "pool-worker-revision.ts"]!);
  writeFileSync(join(tree.root, cli), "// no activation flags\n");
  await assert.rejects(
    sourceContract(tree.candidate, tree.root),
    unavailable(cli, "--activate-change-journal", "missing"),
  );
  appendFileSync(join(tree.root, "patches/0560-fixture.patch"), "edited after release\n");
  await assert.rejects(
    sourceContract(tree.candidate, tree.root),
    unavailable("patches/0560-fixture.patch", "released", "modified"),
  );
});

test("the client has no source root of its own to fall back to", () => {
  assert.equal(candidateSourceRoot({ BASALT_ACTIVATION_SOURCE_ROOT: client }), client);
  for (const source of [
    {},
    { BASALT_ACTIVATION_SOURCE_ROOT: "" },
    { BASALT_ACTIVATION_SOURCE_ROOT: "candidate" },
    { BASALT_ACTIVATION_SOURCE_ROOT: "./candidate" },
  ])
    assert.throws(() => candidateSourceRoot(source), /migration-activation-source-root-required/);
});
