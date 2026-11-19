// Vendored rules keep their upstream form so an update stays a diff against upstream; no
// formatter or linter rewrites them. vendor/ holds the upstream files listed in the manifest,
// which the full check compares with their recorded hashes, plus the manifest and the copy's
// provenance record; any other file there is refused.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDOR = "scripts/owned-lint/vendor/";
export const MANIFEST = `${VENDOR}manifest.json`;
/** The copy's provenance; an upstream update changes its Commit line. */
export const PROVENANCE = `${VENDOR}anti-slop/UPSTREAM.md`;

/** Each vendored file's sha256, by repository path. */
export type Manifest = ReadonlyMap<string, string>;
/** A vendored copy: its recorded files and the upstream commit it names. */
export type VendorState = { readonly manifest: Manifest; readonly commit?: string };

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const isText = (value: unknown): value is string => typeof value === "string";

export function parseManifest(text: string | undefined): Manifest {
  const manifest = new Map<string, string>();
  // An entry that is not a hash matches no file, so the integrity check reports it.
  for (const [file, hash] of Object.entries(text === undefined ? {} : JSON.parse(text)))
    manifest.set(file, isText(hash) ? hash : "");
  return manifest;
}
/** The upstream commit a provenance record names. */
export const commitOf = (text: string | undefined) =>
  text?.match(/^- Commit: `([0-9a-f]{40})`/mu)?.[1];
/** A vendored copy read through `read`, which returns a repository file's text or undefined. */
export const vendorState = (read: (file: string) => string | undefined): VendorState => ({
  manifest: parseManifest(read(MANIFEST)),
  commit: commitOf(read(PROVENANCE)),
});

let checkout: VendorState | undefined;
/** This checkout's vendored copy, read once. */
export const currentVendor = () =>
  (checkout ??= vendorState((file) =>
    existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined,
  ));
export const vendored = (file: string) =>
  file.startsWith(VENDOR) && currentVendor().manifest.has(file);
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

/** The files under vendor/ that an update records: everything but the manifest and provenance. */
export const upstreamFile = (file: string) =>
  file.startsWith(VENDOR) && file !== MANIFEST && file !== PROVENANCE;

/**
 * Files under vendor/ the manifest does not list. Even one that is never linted can change what
 * the vendored rules load, as a package.json can.
 */
export const unrecordedVendorFiles = (files: readonly string[], recorded: Manifest) =>
  files.flatMap((file) =>
    upstreamFile(file) && !recorded.has(file)
      ? [
          `${file} is in ${VENDOR} but is not part of the recorded upstream copy. Put Basalt code outside vendor/, or record an upstream update as ${PROVENANCE} says.`,
        ]
      : [],
  );

/**
 * Recorded files that are not committed as regular files at their own path. Through a symbolic
 * link, of the file or of a directory above it, the hash still matches while the rules load
 * their imports from wherever the link points, and git lists nothing under a linked directory.
 */
export const linkedVendorFiles = (
  recorded: Manifest,
  modeOf: (file: string) => string | undefined,
  realPathOf: (file: string) => string | undefined,
) =>
  [...recorded.keys()].flatMap((file) =>
    /^100(?:644|755)$/u.test(modeOf(file) ?? "") && realPathOf(file) === file
      ? []
      : [
          `${file} is not committed as a regular file at its own path. Vendored files are plain copies; replace the symbolic link with the upstream file.`,
        ],
  );

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
export function vendorPolicy(current: VendorState, base: VendorState) {
  const changes = vendorChanges(current.manifest, base.manifest);
  if (!changes.length) return { problems: [], notices: [] };
  if (current.commit !== undefined && current.commit !== base.commit)
    return {
      problems: [],
      notices: [
        `Vendored anti-slop updated ${base.commit ?? "(none)"} -> ${current.commit}; review the copy against that upstream commit: ${changes.join("; ")}`,
      ],
    };
  return {
    problems: [
      `Vendored code changed without an upstream update (${changes.join("; ")}). Put Basalt code outside vendor/; an upstream update copies a new upstream commit and names it on the Commit line of ${PROVENANCE}.`,
    ],
    notices: [],
  };
}

/** The manifest for the copy now on disk, and how it differs from the recorded one. */
export function nextManifest(files: readonly string[]) {
  const next = new Map<string, string>();
  for (const file of files) {
    const hash = sha256(file);
    if (hash === undefined) throw new Error(`${file} is listed by git but cannot be read.`);
    next.set(file, hash);
  }
  return {
    manifest: Object.fromEntries(next),
    changes: vendorChanges(next, currentVendor().manifest),
  };
}
