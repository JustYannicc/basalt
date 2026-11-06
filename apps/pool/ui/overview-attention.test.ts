import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, PoolView } from "../contract.ts";
import { accountProblems, accountsNeedingSomeone, bankedResetCount } from "./overview-attention.ts";

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  provider: "fixture",
  label: id,
  plan: null,
  state: "active",
  message: null,
  windows: [],
  observedAt: null,
  freshness: "fresh",
  readingFailed: false,
  nextReadAt: null,
  earliestResetAt: null,
  bankedResets: null,
  ...overrides,
});
const view = (accounts: Account[]): PoolView => ({ isOwner: true, providers: [], accounts });

test("attention keeps overlapping symptoms visible and only totals actual available resets", () => {
  const result = view([
    account("a", {
      credentialFailure: "unauthorized",
      readingFailed: true,
      freshness: "stale",
      bankedResets: { available: 2, nextExpiresAt: null },
    }),
    account("b", { state: "disabled", bankedResets: { available: 1, nextExpiresAt: null } }),
  ]);
  assert.deepEqual(
    accountProblems(result).map(({ kind, count }) => [kind, count]),
    [
      ["sign-in", 1],
      ["checks", 1],
      ["readings", 1],
      ["unavailable", 1],
    ],
  );
  assert.equal(bankedResetCount(result), 3);
  assert.deepEqual(accountProblems(view([account("healthy")])), []);
});

test("an account with several symptoms counts once; a stale or first reading alone needs nobody", () => {
  const pool = view([
    account("a", { credentialFailure: "unauthorized", readingFailed: true, freshness: "stale" }),
    account("b", { state: "disabled" }),
    account("c", { freshness: "stale" }),
    account("d", { freshness: "never" }),
    account("e"),
  ]);
  assert.equal(accountsNeedingSomeone(pool), 2);
  assert.equal(accountsNeedingSomeone(view([account("f")])), 0);
});
