import assert from "node:assert/strict";
import { test } from "node:test";
import { stageImages, stageRepositories } from "./stage-images.ts";

const account = "1".repeat(32);
const catalog = [
  `${account}/basalt-rehearsal-poolcontainer-test-rehearsal-81231-abc`,
  `${account}/basalt-test-rehearsal-81231-pool-runtime-green`,
  `${account}/basalt-rehearsal-poolruntimegreen-test-rehearsal-81231`,
  `${account}/basalt-rehearsal-poolcontainer-test-rehearsal-812311-abc`,
  `${account}/basalt-poolcontainer-production-abc`,
  `${account}/basalt-poolcontainer-test-rehearsal-81231`,
  `${"2".repeat(32)}/basalt-rehearsal-poolcontainer-test-rehearsal-81231`,
];

test("only this rehearsal stage's repositories under the rehearsal stack are selected", () => {
  assert.deepEqual(stageRepositories(catalog, account, "test-rehearsal-81231"), catalog.slice(0, 3));
  for (const stage of ["production", "test-pr-12"])
    assert.throws(() => stageRepositories(catalog, account, stage), /only for rehearsal stages/);
});

test("every tagged manifest in those repositories is deleted by digest, then verify sees none", async () => {
  const deleted: string[] = [];
  const tags = new Map([[catalog[0]!, ["one", "two"]], [catalog[1]!, ["four"]], [catalog[2]!, ["three"]]]);
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/credentials")) return Response.json({ success: true, result: { username: "u", password: "p" } });
    if (url.endsWith("_catalog?n=10000")) return Response.json({ repositories: catalog });
    const repository = catalog.find((name) => url.includes(`/v2/${name}/`));
    assert.ok(repository, url);
    assert.ok(tags.has(repository), "a production or foreign repository was touched");
    if (url.endsWith("/tags/list")) return Response.json({ tags: tags.get(repository) });
    if (init?.method === "HEAD")
      return new Response(null, { headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } });
    if (init?.method === "DELETE") {
      deleted.push(repository);
      tags.set(repository, []);
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const input = { accountId: account, token: "t", stage: "test-rehearsal-81231" };
  assert.equal((await stageImages("delete", input, fetcher)).deleted, 4);
  assert.deepEqual([...new Set(deleted)], catalog.slice(0, 3));
  await stageImages("verify", input, fetcher);
  tags.set(catalog[2]!, ["left"]);
  await assert.rejects(stageImages("verify", input, fetcher), /registry images remain/);
});
