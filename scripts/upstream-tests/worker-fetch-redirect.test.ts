import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMiniflare } from "../startup-profiler/profile.ts";

const root = new URL("../../", import.meta.url);

test("native approval reaches the real pool in workerd and refuses redirects", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "basalt-worker-fetch-"));
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  try {
    execFileSync(
      "bun",
      [
        "build",
        "scripts/upstream-tests/worker-fetch-auth.fixture.ts",
        "scripts/upstream-tests/worker-fetch-pool.fixture.ts",
        "--target=browser",
        "--format=esm",
        "--external=node:*",
        "--external=cloudflare:workers",
        `--outdir=${output}`,
      ],
      { cwd: root, stdio: "pipe" },
    );
    for (const redirect of [false, true]) {
      await t.test(
        redirect ? "refuses Location without following it" : "approves on the first call",
        async () => {
          const runtime = new Miniflare(
            convertV4MiniflareOptions({
              workers: [
                {
                  name: "auth",
                  modules: true,
                  script: readFileSync(join(output, "worker-fetch-auth.fixture.js"), "utf8"),
                  compatibilityDate: "2026-09-08",
                  compatibilityFlags: [
                    "nodejs_compat",
                    "global_fetch_strictly_public",
                    "enable_request_signal",
                    "new_module_registry",
                  ],
                  outboundService: "pool",
                },
                {
                  name: "pool",
                  modules: true,
                  script: readFileSync(join(output, "worker-fetch-pool.fixture.js"), "utf8"),
                  compatibilityDate: "2026-09-08",
                  compatibilityFlags: ["nodejs_compat"],
                  bindings: { redirect },
                },
              ],
            }),
          );
          try {
            await runtime.ready;
            const response = await runtime.dispatchFetch("http://localhost:3000/proof");
            assert.equal(response.status, 200, await response.clone().text());
            const result = (await response.json()) as {
              status: number;
              body: Record<string, unknown>;
              grants: number;
              consents: number;
              state: { controlCalls: number; redirectedCalls: number; computers: unknown[] };
            };
            assert.equal(result.state.controlCalls, 1);
            assert.equal(result.state.redirectedCalls, 0);
            if (redirect) {
              assert.equal(result.status, 503);
              assert.equal(result.body.stage, "native_control_response");
              assert.equal(result.body.failure, "status");
              assert.equal(result.body.dependencyStatus, 302);
              assert.equal(result.grants, 0);
              assert.equal(result.consents, 0);
              assert.deepEqual(result.state.computers, []);
            } else {
              assert.equal(result.status, 200);
              assert.deepEqual(result.body, { status: "approved" });
              assert.equal(result.grants, 1);
              assert.equal(result.consents, 1);
              assert.deepEqual(result.state.computers, [
                { state: "active", models: true, hasSealedKey: true },
              ]);
            }
          } finally {
            await runtime.dispose();
          }
        },
      );
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
