import assert from "node:assert/strict";
import { test } from "node:test";
import { poolDatabaseUrl, previewPoolDatabaseBranch } from "./database-settings.ts";

test("pool runtime uses its logical database through PgBouncer without session role options", () => {
  const original =
    "postgresql://runtime:credential@cluster.example:6432/postgres?sslmode=verify-full";
  const url = new URL(poolDatabaseUrl(original));
  assert.equal(url.host, "cluster.example:6432");
  assert.equal(url.username, "runtime");
  assert.equal(url.password, "credential");
  assert.equal(url.pathname, "/basalt_pool");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.searchParams.has("options"), false);
});

test("pool rejects direct, unverified, or session-dependent runtime connections", () => {
  for (const url of [
    "postgresql://runtime:credential@cluster.example:5432/postgres?sslmode=verify-full",
    "postgresql://runtime:credential@cluster.example:6432/postgres?sslmode=require",
    "postgresql://runtime:credential@cluster.example:6432/postgres?sslmode=verify-full&options=-c%20role=owner",
  ])
    assert.throws(() => poolDatabaseUrl(url), /pooled Postgres connection/);
});

test("each PR preview and rehearsal gets its own pool database branch", () => {
  assert.equal(previewPoolDatabaseBranch("test-pr-1419"), "test-pr-1419-pool");
  assert.equal(previewPoolDatabaseBranch("test-rehearsal-1419"), "test-rehearsal-1419-pool");
  for (const stage of ["production", "test-pr-0", "test-rehearsal-0", "test-e2e-1419"])
    assert.throws(() => previewPoolDatabaseBranch(stage), /restricted to PR preview and rehearsal/);
});
