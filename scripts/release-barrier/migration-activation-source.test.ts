import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { historyActivationDefinitions } from "../pool-history-operator.ts";
import { canonical, digest } from "./manifest.ts";
import { assertTrustedDefinitions, candidateSources } from "./migration-activation-source.ts";
import { BarrierRefusal } from "./refusal.ts";

const tooling = fileURLToPath(new URL("../../", import.meta.url));
const hosted = ".upstream/apps/hosted/server/src/implementation/";
const revision = "c".repeat(64);
const marker = "\n// present only in the candidate\n";

/** A released checkout whose every bound source differs from this client's own tree. */
function candidateTree(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "basalt-activation-candidate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const real = (path: string) => readFileSync(join(tooling, path), "utf8");
  const files = {
    "scripts/pool-history-operator.ts": `export const operation = "journal-activation";\n// historyJournalActivationPath${marker}`,
    // The real migrations, so the pool functions parse; the file's bytes are still the candidate's.
    "src/pool/model-history/schema.ts": `export * from ${JSON.stringify(new URL("../../src/pool/model-history/schema.ts", import.meta.url).href)};${marker}`,
    "src/pool/model-history/operator.ts": `export const historyJournalActivationPath = "/candidate-only";\n`,
    "patches/0560-fixture.patch": `candidate carry${marker}`,
    "patches/0560-fixture.json": `{"candidate":true}\n`,
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const untracked = {
    [hosted + "change-journal-schema.ts"]: real(hosted + "change-journal-schema.ts") + marker,
    [hosted + "deferred-change-schema.ts"]: real(hosted + "deferred-change-schema.ts") + marker,
    [hosted + "pool-worker-revision.ts"]: `export const poolWorkerRevision = "${revision}";\n`,
    ".upstream/apps/hosted/cloud/src/migrate.ts":
      real(".upstream/apps/hosted/cloud/src/migrate.ts") + marker,
  };
  for (const [path, content] of Object.entries(untracked)) write(path, content);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("add", "scripts", "src", "patches");
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

const refusal = (reason: string, path: string) => (error: unknown) => {
  assert.ok(error instanceof BarrierRefusal);
  assert.equal(error.reason, reason);
  assert.deepEqual(error.delta?.changed, [{ path, changed: true }]);
  return true;
};

test("main's client binds a plan to the candidate's sources, never its own", async (context) => {
  const tree = candidateTree(context);
  const sources = await candidateSources(tree.candidate, tree.root);
  const schema = await import("../../src/pool/model-history/schema.ts");
  // Stated independently of the client: the digest a client living in the candidate tree computes.
  assert.equal(
    sources.fingerprint,
    digest(
      canonical({
        candidate: tree.candidate,
        sources: [
          ...[
            "scripts/pool-history-operator.ts",
            "src/pool/model-history/schema.ts",
            "patches/0560-fixture.json",
            "patches/0560-fixture.patch",
          ].map((path) => [path, digest(tree.files[path as keyof typeof tree.files])]),
          ["hosted", digest(tree.untracked[hosted + "change-journal-schema.ts"]!)],
          ["hosted-inactive", digest(tree.untracked[hosted + "deferred-change-schema.ts"]!)],
          ["cli", digest(tree.untracked[".upstream/apps/hosted/cloud/src/migrate.ts"]!)],
          [
            "pool-prepared",
            digest(schema.historySchemaMigrations.flatMap((entry) => entry.statements).join("\n")),
          ],
          ["pool-active", digest(canonical(schema.historyJournalActivationMigration))],
        ],
      }),
    ),
  );
  assert.equal(sources.cloud, join(tree.root, ".upstream/apps/hosted/cloud"));
  assert.equal(sources.poolWorkerRevision, revision);
  assert.equal(sources.definitions.historyJournalActivationPath, "/candidate-only");
  assert.deepEqual(
    sources.hosted.active.map((fn) => fn.name),
    ["hosted_flush_changes"],
  );

  // Untracked prepared sources are bound too: a different hosted CLI is a different plan.
  appendFileSync(join(tree.root, ".upstream/apps/hosted/cloud/src/migrate.ts"), "// changed\n");
  assert.notEqual(
    (await candidateSources(tree.candidate, tree.root)).fingerprint,
    sources.fingerprint,
  );
});

test("a source root that is not the exact unmodified candidate refuses, naming the step", async (context) => {
  const tree = candidateTree(context);
  await assert.rejects(
    candidateSources("d".repeat(40), tree.root),
    refusal("migration-activation-source-capability", "checkout.head"),
  );
  await assert.rejects(
    candidateSources(tree.candidate, join(tree.root, "missing")),
    refusal("migration-activation-source-capability", "checkout.head"),
  );
  rmSync(join(tree.root, hosted + "pool-worker-revision.ts"));
  await assert.rejects(
    candidateSources(tree.candidate, tree.root),
    refusal("migration-activation-source-capability", "definitions"),
  );
  appendFileSync(join(tree.root, "src/pool/model-history/schema.ts"), "// edited after release\n");
  await assert.rejects(
    candidateSources(tree.candidate, tree.root),
    refusal("migration-activation-source-capability", "checkout.unmodified"),
  );
});

test("main's operator refuses to describe production once its migration definitions moved on", () => {
  assert.ok(Object.keys(historyActivationDefinitions).length > 0);
  assert.doesNotThrow(() =>
    assertTrustedDefinitions(historyActivationDefinitions, {
      ...structuredClone(historyActivationDefinitions),
      unrelated: "ignored",
    }),
  );
  for (const name of Object.keys(historyActivationDefinitions))
    for (const deployed of [
      { ...historyActivationDefinitions, [name]: "changed in production" },
      Object.fromEntries(
        Object.entries(historyActivationDefinitions).filter(([key]) => key !== name),
      ),
    ])
      assert.throws(
        () => assertTrustedDefinitions(historyActivationDefinitions, deployed),
        (error: unknown) => {
          assert.ok(error instanceof BarrierRefusal);
          assert.equal(error.reason, "migration-activation-tooling-definition-drift");
          assert.equal(error.worker, name);
          const [change] = error.delta?.changed ?? [];
          assert.ok(change && "old" in change && change.old !== change.new);
          return true;
        },
      );
});
