import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleCatalog } from "./worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (suffix: string) => readFileSync(new URL(`./github.${suffix}`, import.meta.url));
const credentials = new Set(["temp_clone_token", "temp_download_token"]);
const dropCredentials = (key: string, value: unknown) => (credentials.has(key) ? undefined : value);

/** Every path at which a credential field appears. */
const credentialPaths = (value: unknown, path = "$"): string[] =>
  Array.isArray(value)
    ? value.flatMap((item, index) => credentialPaths(item, `${path}[${index}]`))
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, item]) => [
          ...(credentials.has(key) ? [`${path}.${key}`] : []),
          ...credentialPaths(item, `${path}.${key}`),
        ])
      : [];

test("GitHub REST results never carry the clone or download tokens GitHub adds", async () => {
  // The publisher, if asked, answers with the package it published.
  const served = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/github.json"),
    async (input) => {
      assert.equal(String(input), "https://catalog.executor.sh/apps/github.json");
      return new Response(bytes("published.json").toString());
    },
  );
  assert.equal(served.status, 200);
  // GitHub's documented bodies, with synthetic token values and the repository marked private,
  // as GitHub sends the clone token only for private repositories. Its example omits the optional
  // `temp_download_token`, so the first runner download carries one as GitHub's schema declares.
  const recorded = JSON.parse(
    readFileSync(new URL("./tests/github-responses.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(credentialPaths(recorded), [
    "$.GET /repos/{owner}/{repo}.template_repository.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.parent.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.source.temp_clone_token",
    "$.GET /user/repos[0].temp_clone_token",
    "$.GET /repos/{owner}/{repo}/actions/runners/downloads[0].temp_download_token",
  ]);
  const directory = mkdtempSync(join(tmpdir(), "github-served-"));
  try {
    const source = join(directory, "github.json");
    const output = join(directory, "results.json");
    writeFileSync(source, await served.text());
    execFileSync(
      "bun",
      [new URL("./tests/github-runtime.mjs", import.meta.url).pathname, root, source, output],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const { results, oversized } = JSON.parse(readFileSync(output, "utf8")) as {
      results: Record<string, unknown>;
      oversized: { ok: boolean; error: unknown; sent: number; total: number };
    };
    assert.deepEqual(credentialPaths(results), [], "tool results carry GitHub credentials");
    // Everything else GitHub sent arrives unchanged.
    const without = (body: unknown) => JSON.parse(JSON.stringify(body), dropCredentials);
    assert.deepEqual(results, {
      "api.repos.get": without(recorded["GET /repos/{owner}/{repo}"]),
      "api.repos.listForAuthenticatedUser": without(recorded["GET /user/repos"]),
      "api.actions.listRunnerApplicationsForRepo": without(
        recorded["GET /repos/{owner}/{repo}/actions/runners/downloads"],
      ),
    });
    // The router refuses a body over its 16 MiB limit; nothing reads all of it into memory first.
    assert.equal(oversized.ok, false, "an oversized body is refused");
    assert.ok(oversized.sent > 0, "the oversized body was requested");
    assert.ok(
      oversized.sent < oversized.total,
      `read ${oversized.sent} of ${oversized.total} bytes: ${JSON.stringify(oversized.error)}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
