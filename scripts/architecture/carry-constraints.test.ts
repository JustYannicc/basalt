import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LikeC4 } from "likec4";
import { expect, test } from "vitest";
import {
  architectureChangeErrors,
  hasConstraint,
  repositoryArchitectureErrors,
} from "./carry-constraints.ts";

const patch = "patches/0245-example.patch";
const record = "patches/0245-example.json";
const constraint = "architecture/model/carries/0245-example.c4";

const source = (text = "Keep generated files reproducible") =>
  `model { extend basalt.build { metadata { constraint ${JSON.stringify(text)} } } }`;
const check = (changed: readonly string[], present: ReadonlySet<string>) =>
  architectureChangeErrors(
    changed,
    present,
    new Map([...present].filter((file) => file.endsWith(".c4")).map((file) => [file, source()])),
  );

test("each changed carry needs its own changed constraint file", () => {
  const present = new Set([patch, record, constraint]);
  for (const changed of [[patch], [record], [patch, "architecture/model/build.c4"]])
    expect(check(changed, present).join("\n")).toContain(constraint);
  expect(check([patch, record, constraint], present)).toEqual([]);
  expect(check([record, constraint], present)).toEqual([]);
  expect(check([patch, constraint], new Set([patch]))).not.toEqual([]);
});

test("a second carry cannot use the first carry's constraint", () => {
  const other = "patches/0246-other.patch";
  const present = new Set([patch, other, constraint]);
  const errors = check([patch, other, constraint], present);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("architecture/model/carries/0246-other.c4");
});

test("renumbered carries need the renamed file, while retirement keeps the architecture gate", () => {
  const renamed = "patches/0246-example.patch";
  const nextConstraint = "architecture/model/carries/0246-example.c4";
  expect(
    check([patch, renamed, constraint, nextConstraint], new Set([renamed, nextConstraint])),
  ).toEqual([]);
  expect(check([patch, "architecture/model/build.c4"], new Set())).toEqual([]);
  expect(check([patch], new Set())).not.toEqual([]);
  expect(check([patch, record], new Set([constraint]))).not.toEqual([]);
  expect(check([patch, record, constraint], new Set())).toEqual([]);
});

test("runtime and stack changes still require architecture, and unrelated changes do not", () => {
  for (const path of [
    "src/router.ts",
    "packages/client/index.ts",
    "containers/pool/Dockerfile",
    "alchemy.run.ts",
    "upstream.json",
  ])
    expect(check([path], new Set())).not.toEqual([]);
  expect(check(["src/router.ts", "architecture/model/basalt.c4"], new Set())).toEqual([]);
  expect(check(["scripts/ci/gate.ts"], new Set())).toEqual([]);
});

test("actual PR changes retain the runtime and carry placement gate", () => {
  expect(
    repositoryArchitectureErrors(
      fileURLToPath(new URL("../../", import.meta.url)),
      process.env.ARCHITECTURE_BASE_SHA,
    ),
  ).toEqual([]);
});

test("unchanged active carries cannot lose their existing constraint files", () => {
  expect(check([constraint], new Set([patch, record])).join("\n")).toContain(constraint);
  expect(check([constraint], new Set([patch, record, constraint]))).toEqual([]);
  expect(check(["docs/releases.md"], new Set([patch, record]))).toEqual([]);
  expect(check([patch, record, constraint], new Set())).toEqual([]);
});

test("every existing carry file needs a real constraint, even when another file changes", () => {
  const present = new Set([patch, record, constraint]);
  for (const invalid of [
    'model { extend basalt.build { metadata { unrelated "present" } } }',
    source(""),
    source(" \n\t "),
    "model { extend basalt.build { metadata { constraint true } } }",
    'model { extend basalt.build { metadata { constraint ["text"] } } }',
    'model { extend basalt.build { metadata { constraint "text" } } } model { invalid }',
    '// model { extend basalt.build { metadata { constraint "Only a comment" } } }',
  ]) {
    expect(hasConstraint(invalid)).toBe(false);
    expect(
      architectureChangeErrors(
        ["docs/releases.md"],
        present,
        new Map([[constraint, invalid]]),
      ).join("\n"),
    ).toContain("non-empty constraint");
  }
  expect(hasConstraint(source('Keep "quoted" text and a newline\ninside the statement'))).toBe(
    true,
  );
});

test("separate carry files extend one element and malformed extensions fail validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-carry-model-"));
  mkdirSync(join(root, "carries"));
  writeFileSync(
    join(root, "base.c4"),
    "specification { element module } model { service = module }",
  );
  const extension = (constraint: string) =>
    `model { extend service { metadata { constraint "${constraint}" } } }`;
  writeFileSync(join(root, "carries/0001-first.c4"), extension("First constraint"));
  writeFileSync(join(root, "carries/0002-second.c4"), extension("Second constraint"));
  try {
    const valid = await LikeC4.fromWorkspace(root, { logger: false });
    try {
      expect(valid.getErrors()).toEqual([]);
      const model = await valid.computedModel();
      expect(model.element("service").metadata.constraint).toEqual([
        "First constraint",
        "Second constraint",
      ]);
    } finally {
      await valid.dispose();
    }
    writeFileSync(
      join(root, "carries/0002-second.c4"),
      'model { extend missing { metadata { constraint "Broken" } } }',
    );
    const invalid = await LikeC4.fromWorkspace(root, { logger: false, printErrors: false });
    try {
      expect(invalid.getErrors().length).toBeGreaterThan(0);
    } finally {
      await invalid.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository fitness rejects a deletion-only PR and unrelated metadata, then permits retirement", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-carry-retention-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    mkdirSync(join(root, "patches"));
    mkdirSync(join(root, "architecture/model/carries"), { recursive: true });
    writeFileSync(join(root, patch), "patch fixture");
    writeFileSync(join(root, record), "{}");
    writeFileSync(join(root, constraint), source());
    const base = commit();
    rmSync(join(root, constraint));
    commit();
    expect(repositoryArchitectureErrors(root, base).join("\n")).toContain("active carry requires");
    writeFileSync(
      join(root, constraint),
      'model { extend basalt.build { metadata { unrelated "present" } } }',
    );
    commit();
    expect(repositoryArchitectureErrors(root, base).join("\n")).toContain("non-empty constraint");
    rmSync(join(root, patch));
    rmSync(join(root, record));
    rmSync(join(root, constraint));
    commit();
    expect(repositoryArchitectureErrors(root, base)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
