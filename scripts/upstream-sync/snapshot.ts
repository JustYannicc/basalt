import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { carryTargets } from "../ci/inputs.ts";
import { materializePatchManifest, parseRegistrySource } from "../releases/patch-layout.ts";
import { assertPoolCarryManifestContent } from "../releases/patch-registry.ts";
import { parseJsonRejectingDuplicateKeys } from "../releases/strict-json.ts";
import { git, readBlobs, resolveCommit, treeEntries } from "./git.ts";

export const sha256 = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");

const headerPath = "scripts/releases/patches.json";
const auxiliaryPaths = ["containers/pool/sources.json", "containers/pool/releases.json"];

export function loadSyncSnapshot(root: string, ref: string) {
  const commit = resolveCommit(root, ref);
  const repositoryEntries = treeEntries(root, commit);
  const entries = repositoryEntries.filter(
    ({ path }) =>
      path === "upstream.json" ||
      path === headerPath ||
      auxiliaryPaths.includes(path) ||
      /^patches\/[^/]+\.(patch|json)$/.test(path) ||
      /^containers\/pool\/patches\/[^/]+\.patch$/.test(path),
  );
  for (const entry of entries)
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error(`Sync input is not a regular file: ${entry.path}`);
  const blobs = readBlobs(
    root,
    entries.map(({ oid }) => oid),
  );
  const files = new Map(entries.map(({ path }, index) => [path, blobs[index]!]));
  const read = (path: string) => {
    const content = files.get(path);
    if (!content) throw new Error(`Missing pinned sync input: ${path}`);
    return content;
  };
  const header = read(headerPath).toString("utf8");
  const manifest = materializePatchManifest(
    header,
    Object.fromEntries(
      [...files]
        .filter(([path]) => path.startsWith("patches/"))
        .map(([path, content]) => [path.slice("patches/".length), { regular: true, content }]),
    ),
  );
  if (manifest.pool_carries)
    assertPoolCarryManifestContent(manifest, read(manifest.pool_carries.manifest));
  const upstream = parseJsonRejectingDuplicateKeys(read("upstream.json").toString("utf8"));
  if (
    typeof upstream !== "object" ||
    upstream === null ||
    !("repository" in upstream) ||
    typeof upstream.repository !== "string" ||
    !("commit" in upstream) ||
    typeof upstream.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(upstream.commit)
  )
    throw new Error("Pinned upstream must name a repository and exact commit");
  const patches = [...manifest.patches]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((record) => ({ record, content: read(`patches/${record.file}`) }));
  const carries = patches.map(({ record, content }) => ({
    ...record,
    record_sha256: files.has(`patches/${record.file.replace(/\.patch$/, ".json")}`)
      ? sha256(read(`patches/${record.file.replace(/\.patch$/, ".json")}`))
      : null,
    bytes: content.byteLength,
    targets: carryTargets(content.toString("utf8"))
      .map((path) => path.slice(".upstream/".length))
      .sort(),
  }));
  const auxiliary = [...files]
    .filter(([file]) => file.startsWith("containers/pool/"))
    .map(([file, content]) => ({ file, sha256: sha256(content), bytes: content.byteLength }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const inputs = {
    upstream: { repository: upstream.repository, commit: upstream.commit },
    registry: { formatVersion: parseRegistrySource(header).format_version, sha256: sha256(header) },
    carries,
    auxiliary,
  };
  const inventory = {
    formatVersion: 1 as const,
    basalt: { commit, tree: git(root, ["rev-parse", `${commit}^{tree}`]).trim() },
    inputSha256: sha256(JSON.stringify(inputs)),
    repositoryInputs: repositoryEntries.filter(({ path }) => !path.startsWith("patches/")),
    ...inputs,
  };
  return { inventory, patches, files };
}

export type SyncInventory = ReturnType<typeof loadSyncSnapshot>["inventory"];
export type SyncSnapshot = ReturnType<typeof loadSyncSnapshot>;

export function retainSyncSnapshot(snapshot: SyncSnapshot, directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "inventory.json"),
    JSON.stringify(snapshot.inventory, null, 2) + "\n",
    {
      flag: "wx",
    },
  );
  for (const [path, content] of snapshot.files) {
    const destination = join(directory, "inputs", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: "wx" });
  }
}
