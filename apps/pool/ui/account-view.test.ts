import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSelectedAccountView, type SelectedAccountView } from "apps";
import type { Account, PoolView } from "../contract.ts";
import { capacityInputs, inspection, readingFacts } from "./account-view.ts";
import { iconSources } from "./lab-icon.ts";
import { accountReadings, latestReading } from "./account-limits.ts";
import { accountProblems, accountsNeedingSomeone, bankedResetLine } from "./overview-attention.ts";

const now = Date.parse("2026-11-12T12:00:00Z");
const svg = (name: string) => `data:image/svg+xml;base64,${btoa(`<svg id="${name}"/>`)}`;

type Member = Account & { nativeView?: SelectedAccountView };
const account = (id: string, overrides: Partial<Member> = {}): Member => ({
  id,
  provider: "fixture",
  label: `${id}@pool.example`,
  plan: "plus",
  state: "active",
  message: null,
  windows: [
    {
      id: "weekly",
      label: "Weekly",
      remainingRatio: 0.4,
      resetAt: "2026-11-15T00:00:00Z",
      windowSeconds: 604_800,
      observedAt: "2026-11-12T11:55:00Z",
    },
  ],
  observedAt: "2026-11-12T11:55:00Z",
  freshness: "fresh",
  readingFailed: false,
  nextReadAt: null,
  earliestResetAt: null,
  bankedResets: { available: 2, nextExpiresAt: null },
  ...overrides,
});

const available = (
  id: string,
  reports: NonNullable<
    Extract<SelectedAccountView, { state: "available" }>["observations"]
  >["reports"],
  canInspect = true,
): SelectedAccountView =>
  decodeSelectedAccountView({
    state: "available",
    account: { id: `acc_${id}`, label: `${id}@source.example`, method: "oauth" },
    sourceApp: {
      id: "provider-app",
      version: "1.0.0",
      name: "Provider",
      icons: [{ src: svg("p") }],
    },
    health: { account: `acc_${id}`, info: null, infoCheckedAt: null, apps: [] },
    canInspect,
    observations: { account: `acc_${id}`, reports },
  });

const record = (
  overrides: Partial<
    NonNullable<
      Extract<SelectedAccountView, { state: "available" }>["observations"]
    >["reports"][number]
  > = {},
) => ({
  source: { kind: "app" as const, id: "provider-app", label: "Provider", version: "1.0.0" },
  credentialGeneration: 1,
  result: {
    observedAt: "2026-11-12T11:58:00Z",
    observation: {
      offering: "subscription" as const,
      plan: { observedAt: "2026-11-12T11:58:00Z", label: "Pro (Max)" },
      windows: [],
      balances: [
        {
          observedAt: "2026-11-12T11:58:00Z",
          id: "r1",
          label: "Resets",
          unit: "resets",
          available: 1,
        },
        {
          observedAt: "2026-11-12T11:58:00Z",
          id: "r2",
          label: "Resets",
          unit: "resets",
          available: 4,
          expiresAt: "2026-11-11T00:00:00Z",
        },
      ],
    },
  },
  checkedAt: "2026-11-12T11:58:00Z",
  lastAttempt: { attemptedAt: "2026-11-12T11:58:00Z", outcome: "success" as const },
  freshness: "fresh" as const,
  collecting: false,
  nextAllowedAt: null,
  ...overrides,
});

const view = (accounts: Member[]): PoolView => ({ isOwner: true, providers: [], accounts });

test("a lab mark takes the provider app's icon for each color scheme, never an invented one", () => {
  assert.equal(iconSources(undefined), null);
  assert.equal(iconSources([]), null);
  // Only image data and HTTPS load; anything else leaves the neutral mark.
  assert.equal(iconSources([{ src: "http://insecure.example/logo.svg" }]), null);
  assert.deepEqual(iconSources([{ src: svg("one") }]), { light: svg("one"), dark: svg("one") });
  assert.deepEqual(
    iconSources([
      { src: svg("dark"), theme: "dark" },
      { src: svg("plain") },
      { src: svg("light"), theme: "light" },
    ]),
    { light: svg("light"), dark: svg("dark") },
  );
  assert.deepEqual(iconSources([{ src: svg("dark"), theme: "dark" }, { src: svg("plain") }]), {
    light: svg("plain"),
    dark: svg("dark"),
  });
});

test("without a resolved provider app the pool's own readings stay, as today", () => {
  const legacy = account("legacy", { freshness: "stale", readingFailed: true });
  assert.deepEqual(inspection(legacy), { kind: "pool" });
  assert.deepEqual(readingFacts(legacy), {
    current: false,
    failed: true,
    since: "2026-11-12T11:55:00Z",
  });
  assert.equal(capacityInputs([legacy])[0], legacy);
});

test("the provider app's view replaces the pool's reading facts", () => {
  // The pool's copy says stale, failed and 2 resets; the source says current, fine and 1 unexpired.
  const native = account("native", {
    freshness: "stale",
    readingFailed: true,
    nativeView: available("native", [record()]),
  });
  assert.deepEqual(readingFacts(native), {
    current: true,
    failed: false,
    since: "2026-11-12T11:58:00Z",
  });
  // A failed latest refresh keeps the last reading but counts as a failed check; stale is stale.
  const failing = account("failing", {
    nativeView: available("failing", [
      record({
        freshness: "stale",
        lastAttempt: { attemptedAt: "2026-11-12T11:59:00Z", outcome: "rate_limited" },
      }),
    ]),
  });
  assert.deepEqual(readingFacts(failing), {
    current: false,
    failed: true,
    since: "2026-11-12T11:59:00Z",
  });
  const unread = account("unread", {
    nativeView: available("unread", [
      record({ result: null, lastAttempt: null, freshness: "unavailable" }),
    ]),
  });
  assert.deepEqual(readingFacts(unread), {
    current: false,
    failed: false,
    since: null,
  });
  // Forecast and routing inputs keep the pool's readings for an inspectable account.
  assert.equal(capacityInputs([native])[0], native);
});

test("a source that refuses inspection withholds allowance, never falling back to the pool's copy", () => {
  const denied = account("denied", {
    readingFailed: true,
    freshness: "stale",
    nativeView: { state: "denied", account: { id: "denied" } } as SelectedAccountView,
  });
  const hidden = account("hidden", {
    readingFailed: true,
    freshness: "stale",
    nativeView: available("hidden", [record()], false),
  });
  for (const member of [denied, hidden]) {
    assert.deepEqual(inspection(member), { kind: "withheld" });
    assert.equal(readingFacts(member), null);
    const [input] = capacityInputs([member]);
    assert.equal(input?.id, member.id);
    assert.equal(input?.provider, member.provider);
    assert.equal(input?.plan, null);
    assert.deepEqual(input?.windows, []);
  }
  const pool = view([denied, hidden]);
  assert.equal(bankedResetLine(pool, now), null);
  assert.equal(accountReadings(denied), null);
  assert.equal(accountReadings(hidden), null);
  assert.deepEqual(
    accountProblems(pool).map(({ kind }) => kind),
    [],
  );
  assert.equal(accountsNeedingSomeone(pool), 0);
  // Credentials and membership are the pool's own, so they still show whatever the inspection.
  const signedOut = account("signed-out", {
    credentialFailure: "unauthorized",
    nativeView: { state: "denied", account: { id: "signed-out" } } as SelectedAccountView,
  });
  assert.deepEqual(
    accountProblems(view([signedOut])).map(({ kind, count, since }) => [kind, count, since]),
    [["sign-in", 1, null]],
  );
  assert.equal(accountsNeedingSomeone(view([signedOut])), 1);
});

test("Details and the reset line quote the provider app's report, kinds and model limits intact", () => {
  const at = "2026-11-12T11:58:00Z";
  const observation = {
    offering: "subscription" as const,
    plan: { observedAt: at, label: "Pro (Max)" },
    windows: [
      {
        observedAt: at,
        id: "weekly",
        label: "Weekly",
        scope: { kind: "account" },
        measure: { unit: "%", remainingRatio: 0.6 },
      },
      {
        observedAt: at,
        id: "weekly-fable",
        label: "Weekly Fable",
        scope: { kind: "model", id: "fable" },
        measure: { unit: "%", remainingRatio: 0.02 },
      },
    ],
    balances: [
      {
        observedAt: at,
        id: "weekly-resets",
        label: "Weekly resets",
        unit: "resets",
        available: 2,
        scope: { kind: "account" as const },
        reset: { kind: "weekly" as const },
      },
      {
        observedAt: at,
        id: "fable-resets",
        label: "Fable resets",
        unit: "resets",
        available: 1,
        scope: { kind: "model" as const, id: "fable" },
        reset: { kind: "model" as const },
      },
    ],
  };
  // The latest refresh failed; the source keeps its last reading, which Details shows as reported.
  const failing = record({
    result: { observedAt: at, observation },
    freshness: "stale",
    lastAttempt: { attemptedAt: "2026-11-12T11:59:00Z", outcome: "rate_limited" },
  });
  const native = account("native", {
    // The pool's copy is never mixed in once the provider app reports.
    bankedResets: { available: 9, nextExpiresAt: null },
    nativeView: available("native", [failing]),
  });
  const [reading] = accountReadings(native) ?? [];
  assert.deepEqual(reading?.observation, observation);
  assert.equal(reading?.state, "last-known");
  assert.deepEqual(reading?.failure, { at: "2026-11-12T11:59:00Z", outcome: "rate_limited" });
  assert.equal(latestReading(accountReadings(native)), reading);
  // A source with no reading yet keeps its row empty rather than borrowing the pool's.
  const unread = account("unread", {
    nativeView: available("unread", [
      record({ result: null, lastAttempt: null, freshness: "unavailable" }),
    ]),
  });
  assert.equal(accountReadings(unread)?.[0]?.observation, null);
  assert.equal(latestReading(accountReadings(unread)), undefined);
  // Kinds stay apart, the model reset stays model-scoped, and a last-known count says so.
  assert.equal(
    bankedResetLine(view([native, unread]), now)?.text,
    "Last known: 2 weekly resets · 1 Fable reset",
  );
  // Two sources reporting the same balance count it once, from the newer reading.
  const twice = account("twice", {
    nativeView: available("twice", [
      record({ result: { observedAt: "2026-11-12T11:50:00Z", observation } }),
      record({ result: { observedAt: at, observation } }),
    ]),
  });
  assert.equal(
    bankedResetLine(view([twice]), now)?.text,
    "2 weekly resets · 1 Fable reset available",
  );
});
