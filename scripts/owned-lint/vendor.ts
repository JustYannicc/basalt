// Vendored rules keep their upstream form so an update stays a diff against upstream; no
// formatter or linter rewrites them. Only the files under vendor/ recorded in the manifest with
// their upstream hash count as vendored: any other file there is Basalt code and is checked like
// the rest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDOR = "scripts/owned-lint/vendor/";
export const MANIFEST = `${VENDOR}manifest.json`;
/** The copy's provenance; an upstream update changes its Commit line. */
export const PROVENANCE = `${VENDOR}anti-slop/UPSTREAM.md`;

/** Each vendored file's sha256, by repository path. */
export type Manifest = ReadonlyMap<string, string>;

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) =>
  existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined;

export const parseManifest = (text: string | undefined): Manifest =>
  new Map(Object.entries<string>(text === undefined ? {} : JSON.parse(text)));
/** The upstream commit a provenance record names. */
export const commitOf = (text: string | undefined) =>
  text?.match(/^- Commit: `([0-9a-f]{40})`/mu)?.[1];

export const manifest = parseManifest(read(MANIFEST));
export const currentCommit = () => commitOf(read(PROVENANCE));
export const vendored = (file: string) => file.startsWith(VENDOR) && manifest.has(file);
export const sha256 = (file: string) => {
  const path = join(root, file);
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : undefined;
};

/** Recorded vendored files whose content is no longer the upstream copy, or that sit outside vendor/. */
export const vendorProblems = (recorded: Manifest, hashOf: (file: string) => string | undefined) =>
  [...recorded].flatMap(([file, hash]) => {
    if (!file.startsWith(VENDOR))
      return [
        `${MANIFEST} records ${file}, which is outside ${VENDOR}; only vendored upstream code is recorded there.`,
      ];
    return hashOf(file) === hash
      ? []
      : [
          `${file} is not the upstream copy recorded in ${MANIFEST}. Vendored code stays byte-identical to upstream: put Basalt code outside vendor/, or record an upstream update as ${PROVENANCE} says.`,
        ];
  });

/** Vendored files added, changed or removed against the base, one line per kind. */
export function vendorChanges(current: Manifest, base: Manifest) {
  const differ = [...new Set([...current.keys(), ...base.keys()])]
    .sort()
    .filter((file) => current.get(file) !== base.get(file));
  const kinds = {
    added: differ.filter((file) => !base.has(file)),
    changed: differ.filter((file) => base.has(file) && current.has(file)),
    removed: differ.filter((file) => !current.has(file)),
  };
  return Object.entries(kinds).flatMap(([kind, files]) =>
    files.length ? [`${kind} ${files.length}: ${files.join(", ")}`] : [],
  );
}

/**
 * Vendored code changes only as an upstream update, which copies a new upstream commit and
 * names it on the provenance Commit line. Nothing here can check the copy against upstream, so
 * the update is listed with both commits for review.
 */
export function vendorPolicy(
  current: Manifest,
  base: Manifest,
  commit: { readonly base?: string; readonly current?: string },
) {
  const changes = vendorChanges(current, base);
  if (!changes.length) return { problems: [], notices: [] };
  if (commit.current !== undefined && commit.current !== commit.base)
    return {
      problems: [],
      notices: [
        `Vendored anti-slop updated ${commit.base ?? "(none)"} -> ${commit.current}; review the copy against that upstream commit: ${changes.join("; ")}`,
      ],
    };
  return {
    problems: [
      `Vendored code changed without an upstream update (${changes.join("; ")}). Put Basalt code outside vendor/; an upstream update copies a new upstream commit and names it on the Commit line of ${PROVENANCE}.`,
    ],
    notices: [],
  };
}

/** Records the vendored code files with their hashes, after an upstream update replaced the copy. */
export function writeVendor(files: readonly string[]) {
  const next = new Map(files.map((file) => [file, sha256(file) ?? ""]));
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`);
  const changes = vendorChanges(next, manifest);
  console.log(
    `Vendored manifest written: ${files.length} files${changes.length ? `; ${changes.join("; ")}` : ""}.`,
  );
}
