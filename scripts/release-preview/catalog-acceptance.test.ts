import { catalogAcceptanceOperation } from "./catalog-acceptance-report.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { catalogAcceptanceApps } from "./catalog-acceptance-inventory.ts";
import { requireSuccessfulCatalogAcceptance } from "./catalog-acceptance-receipt.ts";
import { runCatalogAcceptance } from "./catalog-acceptance.ts";
import { record } from "./catalog-acceptance-source.ts";
import { previewReceipt } from "./receipt.ts";

const origin = "https://preview.example.invalid";
const head = "a".repeat(40);
const config = {
  origin,
  email: "smoke@example.invalid",
  password: "synthetic-password",
  organizationId: "org_preview",
  poolAppId: "app_existing_pool",
};
type Fault = "missing-witness" | "source-mismatch" | "memory" | "refusal" | "cleanup";

async function fixture(fault?: Fault) {
  const sources = new Map<string, unknown>();
  for (const app of catalogAcceptanceApps) {
    const response = await handleCatalog(
      new Request(`${origin}/catalog/apps/${app.entry}.json`),
      async () => {
        throw new Error("A local publisher fixture tried to fetch a remote source");
      },
    );
    assert.equal(response.status, 200, app.entry);
    sources.set(app.entry, await response.json());
  }
  const apps = new Map<string, string>([[config.poolAppId, "existing-pool"]]);
  const installs: { entry: string; name: string; newInstance: boolean }[] = [];
  const deleted: string[] = [];
  let signedIn = false;
  let concurrentInstalls = 0;
  let maximumConcurrentInstalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/api/auth/sign-in/email") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: config.email,
        password: config.password,
      });
      signedIn = true;
      return Response.json(
        { user: { id: "user_synthetic" } },
        { headers: { "Set-Cookie": "session=synthetic; Path=/; Secure; HttpOnly" } },
      );
    }
    if (path === "/api/auth/sign-out") {
      signedIn = false;
      return Response.json({ success: true });
    }
    if (path === "/api/auth/get-session")
      return Response.json(signedIn ? { user: { id: "user_synthetic" } } : null);
    if (path.startsWith("/catalog/apps/")) {
      const entry = path.slice("/catalog/apps/".length, -".json".length);
      const source = structuredClone(sources.get(entry));
      if (fault === "source-mismatch" && entry === "aws") {
        const files = record(source).files;
        assert.ok(Array.isArray(files));
        const code = files.map(record).find((file) => file.path === "index.ts");
        assert.ok(code);
        code.content = `${String(code.content)}\n// Different served candidate\n`;
      }
      return Response.json(source, {
        headers: {
          "x-basalt-preview-head": head,
          ...(fault === "missing-witness" && entry === "aws"
            ? {}
            : { "x-basalt-preview-compiler-cache-mode": "cold" }),
        },
      });
    }
    assert.equal(signedIn, true);
    assert.match(new Headers(init?.headers).get("Cookie") ?? "", /session=synthetic/);
    if (path === "/api/catalog")
      return Response.json(
        catalogAcceptanceApps.map((app) => ({ id: app.entry, package: app.package })),
      );
    if (path.endsWith("/inventory"))
      return Response.json({ apps: [...apps.keys()].map((id) => ({ id })) });
    if (path.endsWith("/apps/install")) {
      assert.equal(method, "POST");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.newInstance, true);
      const app = catalogAcceptanceApps.find((app) => app.entry === payload.entry);
      assert.ok(app);
      installs.push(payload);
      concurrentInstalls++;
      maximumConcurrentInstalls = Math.max(maximumConcurrentInstalls, concurrentInstalls);
      await Promise.resolve();
      concurrentInstalls--;
      if (app.entry === "aws" && (fault === "memory" || fault === "refusal"))
        return Response.json(
          {
            _tag: fault === "memory" ? "BuildMemoryExceeded" : "CatalogImportFailed",
            code: "invalid_source",
          },
          { status: 422 },
        );
      const id = `app_acceptance_${app.entry.replaceAll("-", "_")}`;
      apps.set(id, app.entry);
      return Response.json({
        id,
        name: payload.name,
        activeVersion: `ver_${app.entry.replaceAll("-", "_")}`,
        reused: false,
        service: { id: app.package, newInstance: true },
        copiedFrom: {
          name: app.package,
          reference: `${origin}/catalog/apps/${app.entry}.json`,
          commit: null,
        },
      });
    }
    const match = /\/apps\/([^/]+)(\/source)?$/.exec(path);
    assert.ok(match);
    const id = match[1]!;
    const entry = apps.get(id);
    assert.ok(entry, "The runner requested an unknown or removed app");
    if (match[2]) {
      assert.equal(method, "GET");
      assert.equal(url.searchParams.get("version"), `ver_${entry.replaceAll("-", "_")}`);
      return Response.json({ files: record(sources.get(entry)).files });
    }
    assert.equal(method, "DELETE");
    assert.notEqual(id, config.poolAppId, "The seeded pool must never be deleted");
    deleted.push(id);
    if (fault === "cleanup" && entry === "aws")
      return Response.json({ _tag: "StorageError" }, { status: 500 });
    apps.delete(id);
    return Response.json({ app: id });
  };
  return { fetcher, installs, deleted, apps, concurrency: () => maximumConcurrentInstalls };
}

async function run(fault?: Fault) {
  const mock = await fixture(fault);
  const root = await mkdtemp(join(tmpdir(), "catalog-acceptance-test-"));
  try {
    const path = join(root, "result.json");
    const result = await runCatalogAcceptance(config, head, path, { fetch: mock.fetcher });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), result);
    return { result, mock };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the public installer compiles all 33 sequentially, binds active source and cleans only new app IDs", async () => {
  const { result, mock } = await run();
  requireSuccessfulCatalogAcceptance(result, head);
  const smoke = {
    version: 1,
    mode: "preview",
    signIn: true,
    pool: true,
    cleanup: true,
    clients: ["claude", "codex"].map((client) => ({
      client,
      exit: 0,
      timeout: false,
      modelRequest: true,
      toolSearch: true,
      undo: true,
      revoke: true,
    })),
  };
  const receipt = previewReceipt(
    smoke,
    { pullRequest: 42, head, base: "b".repeat(40), compilerAcceptance: true },
    true,
    result,
  );
  assert.equal(receipt.version, 2);
  if (receipt.version === 2) assert.deepEqual(receipt.catalogAcceptance, result);

  assert.equal(mock.installs[0]?.entry, "aws");
  assert.deepEqual(
    mock.installs.map((app) => app.entry),
    catalogAcceptanceApps.map((app) => app.entry),
  );
  assert.equal(mock.concurrency(), 1);
  assert.equal(result.rows.filter((row) => row.outcome === "success").length, 33);
  assert.deepEqual(new Set(mock.deleted), new Set(result.cleanup.createdAppIds));
  assert.deepEqual([...mock.apps.keys()], [config.poolAppId]);
  assert.throws(() => requireSuccessfulCatalogAcceptance(result, "b".repeat(40)));
});

for (const fault of ["missing-witness", "source-mismatch"] as const) {
  test(`${fault} blocks that install and fails the receipt while later apps still run`, async () => {
    const { result, mock } = await run(fault);
    assert.equal(result.rows.length, 33);
    assert.equal(result.rows[0]?.outcome, "failed");
    assert.equal(mock.installs.length, 32);
    assert.equal(result.rows.at(-1)?.outcome, "success");
    assert.throws(() => requireSuccessfulCatalogAcceptance(result, head));
  });
}

for (const fault of ["memory", "refusal"] as const) {
  test(`${fault} records the final public error and fails all-33 acceptance without a client retry`, async () => {
    const { result, mock } = await run(fault);
    assert.deepEqual(
      mock.installs.map((app) => app.entry),
      catalogAcceptanceApps.map((app) => app.entry),
    );
    assert.equal(result.rows[0]?.outcome, fault === "memory" ? "BuildMemoryExceeded" : "failed");
    assert.equal(
      result.rows[0]?.failure,
      fault === "memory" ? "BuildMemoryExceeded" : "CatalogImportFailed",
    );
    assert.equal(result.cleanup.createdAppIds.length, 32);
    assert.equal(result.cleanup.verifiedAbsent, true);
    assert.throws(() => requireSuccessfulCatalogAcceptance(result, head));
  });
}

test("a cleanup refusal cannot produce a successful receipt", async () => {
  const { result, mock } = await run("cleanup");
  assert.equal(result.rows.filter((row) => row.outcome === "success").length, 33);
  assert.equal(result.cleanup.verifiedAbsent, false);
  assert.equal(mock.apps.size, 2);
  assert.throws(() => requireSuccessfulCatalogAcceptance(result, head));
});

for (const fault of ["memory", "source-mismatch", "cleanup"] as const) {
  test(`a failed private child reports safe ${fault} details before teardown`, async () => {
    const { result } = await run(fault);
    const directory = await mkdtemp(join(tmpdir(), "catalog-report-"));
    try {
      const path = join(directory, "result.json");
      const summaryPath = join(directory, "summary.md");
      await writeFile(path, JSON.stringify(result));
      const lines: string[] = [];
      await assert.rejects(
        catalogAcceptanceOperation(
          async () => {
            throw new Error("private-secret-that-must-not-escape");
          },
          path,
          head,
          {
            summaryPath,
            emit: (line) => {
              lines.push(line);
            },
          },
        ),
        /safe details/,
      );
      const summary = await readFile(summaryPath, "utf8");
      assert.ok(lines.some((line) => line.includes("aws:")));
      assert.ok(summary.includes("aws:"));
      assert.ok(!summary.includes("private-secret-that-must-not-escape"));
      if (fault === "memory") assert.match(summary, /BuildMemoryExceeded/);
      if (fault === "source-mismatch") {
        assert.ok(summary.includes(result.rows[0]!.expectedDocumentSha256));
        assert.ok(summary.includes(result.rows[0]!.observedDocumentSha256!));
      }
      if (fault === "cleanup") assert.match(summary, /deletion was not confirmed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
