import assert from "node:assert/strict";
import { test } from "node:test";
import { rehearsalRegistry, rehearsalRepositories } from "./rehearsal-registry-cleanup.ts";

test("only the rehearsal stack's repositories in this account qualify", () => {
  assert.deepEqual(
    rehearsalRepositories(
      [
        "acct/basalt-rehearsal-poolcontainer-x",
        "acct/basalt-poolcontainer-production-y",
        "other/basalt-rehearsal-z",
        "acct/basalt-rehearsal-a/b",
      ],
      "acct",
    ),
    ["acct/basalt-rehearsal-poolcontainer-x"],
  );
});

test("delete removes each rehearsal tag by digest and never touches production", async () => {
  const calls: string[] = [];
  const digest = `sha256:${"a".repeat(64)}`;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://", "")}`);
    if (url.includes("/credentials"))
      return Response.json({ success: true, result: { username: "u", password: "p" } });
    if (url.endsWith("_catalog?n=10000"))
      return Response.json({
        repositories: ["acct/basalt-rehearsal-pool", "acct/basalt-pool-production"],
      });
    if (url.endsWith("/tags/list")) return Response.json({ tags: ["t1"] });
    if (init?.method === "HEAD")
      return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  assert.deepEqual(
    await rehearsalRegistry("delete", { accountId: "acct", token: "tok" }, fetcher),
    { repositories: ["basalt-rehearsal-pool"], tags: 1, deleted: 1 },
  );
  assert.ok(
    calls.includes(
      `DELETE registry.cloudflare.com/v2/acct/basalt-rehearsal-pool/manifests/${digest}`,
    ),
  );
  assert.ok(calls.every((call) => !call.includes("production")));
});
