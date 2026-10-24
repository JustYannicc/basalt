import assert from "node:assert/strict";
import { test } from "node:test";
import { poolDatabaseUrl, previewPoolDatabaseBranch } from "./database-settings.ts";

test("pool uses its own logical database and stable owner on the existing direct TLS connection", () => {
  const original = "postgresql://runtime:credential@cluster.example:5432/postgres?sslmode=verify-full";
  const url = new URL(poolDatabaseUrl(original));
  assert.equal(url.host, "cluster.example:5432");
  assert.equal(url.username, "runtime");
  assert.equal(url.password, "credential");
  assert.equal(url.pathname, "/basalt_pool");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.searchParams.get("options"), "-c role=basalt_pool_owner");
});

test("pool rejects a pooled or unverified connection", () => {
  for (const url of [
    "postgresql://runtime:credential@cluster.example:6432/postgres?sslmode=verify-full",
    "postgresql://runtime:credential@cluster.example:5432/postgres?sslmode=require",
  ]) assert.throws(() => poolDatabaseUrl(url), /direct Postgres connection with verified TLS/);
});

test("each PR preview gets its own pool database branch", () => {
  assert.equal(previewPoolDatabaseBranch("test-pr-1419"), "test-pr-1419-pool");
  assert.throws(() => previewPoolDatabaseBranch("production"), /restricted to PR preview stages/);
  assert.throws(() => previewPoolDatabaseBranch("test-pr-0"), /restricted to PR preview stages/);
});
