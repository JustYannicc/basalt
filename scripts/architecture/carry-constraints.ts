import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const carryPath = /^(?:patches|containers\/pool\/patches)\/(\d{4}-.+)\.(?:patch|json)$/;
const constraintPath = /^architecture\/model\/carries\/(\d{4}-.+)\.c4$/;
const identifier = "[a-zA-Z_][a-zA-Z0-9_-]*";
const statement = new RegExp(
  `^\\s*model\\s*\\{\\s*extend\\s+${identifier}(?:\\.${identifier})*\\s*\\{\\s*metadata\\s*\\{\\s*constraint\\s+("(?:[^"\\\\]|\\\\.)*")\\s*;?\\s*\\}\\s*\\}\\s*\\}\\s*$`,
);

export function hasConstraint(source: string) {
  const match = statement.exec(source);
  if (!match) return false;
  try {
    return String(JSON.parse(match[1]!)).trim().length > 0;
  } catch {
    return false;
  }
}

export function architectureChangeErrors(
  changed: readonly string[],
  present: ReadonlySet<string>,
  constraints: ReadonlyMap<string, string>,
) {
  const errors: string[] = [];
  const boundary = changed.some((file) =>
    /^(?:src\/|packages\/|containers\/|alchemy\.run\.ts$|upstream\.json$|patches\/)/.test(file),
  );
  if (boundary && !changed.some((file) => /^architecture\/.+\.(?:c4|likec4|md)$/.test(file)))
    errors.push("Runtime or stack changes must update architecture in the same PR");
  const changedCarries = new Set(
    changed.flatMap((file) => {
      const match = carryPath.exec(file);
      return match ? [match[1]!] : [];
    }),
  );
  // Unchanged legacy prose stays grandfathered. Every existing or removed carry file remains governed.
  const governed = new Set([
    ...changedCarries,
    ...[...present, ...changed].flatMap((file) => {
      const match = constraintPath.exec(file);
      return match ? [match[1]!] : [];
    }),
  ]);
  for (const stem of governed) {
    const constraint = `architecture/model/carries/${stem}.c4`;
    const active =
      present.has(`patches/${stem}.patch`) ||
      present.has(`patches/${stem}.json`) ||
      present.has(`containers/pool/patches/${stem}.patch`);
    if (!active) {
      if (present.has(constraint))
        errors.push(`${stem}: remove ${constraint} when retiring the carry`);
      continue;
    }
    if (!present.has(constraint)) {
      errors.push(`${stem}: active carry requires ${constraint}`);
      continue;
    }
    if (changedCarries.has(stem) && !changed.includes(constraint))
      errors.push(`${stem}: update ${constraint} with this carry's durable constraint`);
    if (!hasConstraint(constraints.get(constraint) ?? ""))
      errors.push(
        `${constraint}: expected one model extension with non-empty constraint metadata as a JSON string`,
      );
  }
  return errors;
}

const metadataSnapshot = /^src\/catalog\/[^/]+\.oauth-metadata\.json$/;
const reviewRegistry = "src/catalog/oauth-reviews.json";
const pinLine = /^[+-]\s*"metadataSha256": "[a-f0-9]{64}",?$/;

/**
 * A reviewed OAuth metadata re-pin moves only snapshots and their digests. The runtime never reads
 * the snapshots and ignores the digests, so the drift job's re-pin needs no architecture change.
 */
export function withoutMetadataRepins(changed: readonly string[], registryDiff: string) {
  const content = registryDiff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)(?: |$)/.test(line));
  // A diff without content lines can't prove a pin-only change, so it keeps the rule.
  const digestsOnly = content.length > 0 && content.every((line) => pinLine.test(line));
  return changed.filter(
    (file) => !metadataSnapshot.test(file) && !(file === reviewRegistry && digestsOnly),
  );
}

export function repositoryArchitectureErrors(root: string, base: string | undefined) {
  if (!base) return [];
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid architecture comparison commit");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim().split("\n");
  const changed = withoutMetadataRepins(
    git("diff", "--no-renames", "--name-only", `${base}...HEAD`),
    git(
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--unified=0",
      `${base}...HEAD`,
      "--",
      reviewRegistry,
    ).join("\n"),
  );
  const present = new Set(git("ls-files"));
  const constraints = new Map(
    [...present]
      .filter((file) => constraintPath.test(file))
      .map((file) => [file, readFileSync(join(root, file), "utf8")]),
  );
  return architectureChangeErrors(changed, present, constraints);
}
