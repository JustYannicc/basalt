import assert from "node:assert/strict";

// The framework reference the Authoring Worker embeds, generated as the build generates it.
const { generateFrameworkReference } = await import(
  new URL("../../../.upstream/packages/apps/scripts/reference.mjs", import.meta.url).href
);
const reference = await generateFrameworkReference();

assert.ok(reference.entries.length > 0, "the reference lists the framework's symbols");
// A source that leaves the workspace's parent names the dependency store, whose directory is new
// on every install; a dependency is named from its last `node_modules` instead.
const outside = reference.entries
  .map((entry) => entry.source)
  .filter((source) => source.startsWith("../") || source.startsWith("/"));
assert.deepEqual(outside, [], "no reference source names a location outside the workspace");
for (const entry of reference.entries)
  if (entry.source.includes("node_modules/"))
    assert.ok(
      entry.source.startsWith("node_modules/"),
      `${entry.symbol} names its dependency's store`,
    );
