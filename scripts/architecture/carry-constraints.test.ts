import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LikeC4 } from "likec4";
import { expect, test } from "vitest";
import { architectureChangeErrors } from "./carry-constraints.ts";

const patch = "patches/0245-example.patch";
const record = "patches/0245-example.json";
const constraint = "architecture/model/carries/0245-example.c4";

test("each changed carry needs its own changed constraint file", () => {
  const present = new Set([patch, record, constraint]);
  for (const changed of [[patch], [record], [patch, "architecture/model/build.c4"]])
    expect(architectureChangeErrors(changed, present).join("\n")).toContain(constraint);
  expect(architectureChangeErrors([patch, record, constraint], present)).toEqual([]);
  expect(architectureChangeErrors([record, constraint], present)).toEqual([]);
  expect(architectureChangeErrors([patch, constraint], new Set([patch]))).not.toEqual([]);
});

test("a second carry cannot use the first carry's constraint", () => {
  const other = "patches/0246-other.patch";
  const present = new Set([patch, other, constraint]);
  const errors = architectureChangeErrors([patch, other, constraint], present);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("architecture/model/carries/0246-other.c4");
});

test("renumbered carries need the renamed file, while retirement keeps the architecture gate", () => {
  const renamed = "patches/0246-example.patch";
  const nextConstraint = "architecture/model/carries/0246-example.c4";
  expect(
    architectureChangeErrors(
      [patch, renamed, constraint, nextConstraint],
      new Set([renamed, nextConstraint]),
    ),
  ).toEqual([]);
  expect(architectureChangeErrors([patch, "architecture/model/build.c4"], new Set())).toEqual([]);
  expect(architectureChangeErrors([patch], new Set())).not.toEqual([]);
  expect(architectureChangeErrors([patch, record], new Set([constraint]))).not.toEqual([]);
  expect(architectureChangeErrors([patch, record, constraint], new Set())).toEqual([]);
});

test("runtime and stack changes still require architecture, and unrelated changes do not", () => {
  for (const path of [
    "src/router.ts",
    "packages/client/index.ts",
    "containers/pool/Dockerfile",
    "alchemy.run.ts",
    "upstream.json",
  ])
    expect(architectureChangeErrors([path], new Set())).not.toEqual([]);
  expect(
    architectureChangeErrors(["src/router.ts", "architecture/model/basalt.c4"], new Set()),
  ).toEqual([]);
  expect(architectureChangeErrors(["scripts/ci/gate.ts"], new Set())).toEqual([]);
});

test("PRs changing runtime or carries update architecture in the same PR", () => {
  const base = process.env.ARCHITECTURE_BASE_SHA;
  if (!base) return;
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid architecture comparison commit");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim().split("\n");
  const changed = git("diff", "--no-renames", "--name-only", `${base}...HEAD`);
  expect(architectureChangeErrors(changed, new Set(git("ls-files")))).toEqual([]);
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
