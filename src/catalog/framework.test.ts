import assert from "node:assert/strict";
import { test } from "node:test";
import { poolFrameworkVersion } from "../../scripts/pool-app-bundle.ts";
import type { Feed } from "./feed.ts";
import { onServedFramework } from "./framework.ts";
import { catalog } from "./settings.ts";
import { handleCatalog } from "./worker.ts";

const origin = "https://app.signalbox.run";
const published = "0.0.1-beta.100";
/** An official package as the publisher serves it, pinned to a published `apps` release. */
const officialSource = (name: string) =>
  JSON.stringify({
    package: name,
    files: [
      { path: "index.ts", content: "export default {};\n" },
      {
        path: "package.json",
        content: `${JSON.stringify({ name, dependencies: { apps: published, other: "1.0.0" } }, null, 2)}\n`,
      },
    ],
  });
const official: Feed = {
  version: 1,
  apps: ["gitlab", "miro", "slack", "gmail", "elevenlabs"].map((id) => ({
    id,
    package: `@executor.sh/${id}`,
    name: id,
    description: "Official description.",
    auth: [],
    icons: [],
    source: `apps/${id}.json`,
  })),
};
const publisher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/index.json")) return Response.json(official);
  const id = /\/apps\/([^/]+)\.json$/.exec(url)?.[1];
  return id === undefined ? new Response(null, { status: 404 }) : new Response(officialSource(`@executor.sh/${id}`));
};

test("the catalog serves the framework release Basalt's compiler ships", () => {
  assert.equal(catalog.framework, poolFrameworkVersion);
});

test("every package the catalog serves declares the served framework", async () => {
  const index = (await (await handleCatalog(new Request(`${origin}/catalog/index.json`), publisher)).json()) as Feed;
  const declared: Record<string, unknown> = {};
  for (const entry of index.apps) {
    const response = await handleCatalog(new Request(`${origin}/catalog/${entry.source}`), publisher);
    // Additions not set up in this environment have no source to serve.
    if (response.status === 503) continue;
    assert.equal(response.status, 200, entry.id);
    const source = (await response.json()) as { files: { path: string; content: string }[] };
    const manifest = source.files.find((file) => file.path === "package.json");
    if (manifest !== undefined) declared[entry.id] = JSON.parse(manifest.content).dependencies?.apps;
  }
  // Official, carried and Basalt's own packages alike.
  for (const id of ["gmail", "elevenlabs", "gitlab", "miro", "slack", "zendesk", "atlassian", "aws"])
    assert.ok(Object.hasOwn(declared, id), `${id} was served`);
  assert.deepEqual(
    Object.entries(declared).filter(([, version]) => version !== undefined && version !== catalog.framework),
    [],
  );
});

test("a served official package keeps everything but the framework it declares", () => {
  const served = JSON.parse(onServedFramework(officialSource("@executor.sh/example"))) as {
    package: string;
    files: { path: string; content: string }[];
  };
  const original = JSON.parse(officialSource("@executor.sh/example")) as typeof served;
  assert.equal(served.package, original.package);
  assert.deepEqual(served.files[0], original.files[0]);
  assert.deepEqual(JSON.parse(served.files[1]!.content), {
    name: "@executor.sh/example",
    dependencies: { apps: catalog.framework, other: "1.0.0" },
  });
  // Text that is not a package pinned to another release passes through byte for byte.
  for (const text of [
    '{"package":"@example/gmail","files":[]}',
    '{"package":"x","files":[{"path":"package.json","content":"{\\"name\\":\\"x\\"}"}]}',
    "not json",
    '{"package":"x"}',
  ])
    assert.equal(onServedFramework(text), text);
});
