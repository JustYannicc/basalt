// Every date and time a person reads: day-month-year and a 24-hour clock, whatever the locale
// would pick, with a reset's exact moment beside its countdown instead of only on hover.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balanceView,
  windowView,
} from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-text.ts";
import { formatMoment } from "../../../.upstream/packages/ui/src/implementation/hooks/display-format.ts";

// The pool formats in the browser's own time zone; pin it before its formatters are built.
process.env.TZ = "Europe/Zurich";
const { exactTime, resetsIn } = await import("./usage.ts");

const zurich = (locale: string) => ({ locale, timeZone: "Europe/Zurich" });
const locales = ["en-US", "en-GB", "de-CH", "fr-FR", "ja-JP", "ar-EG", "en-CA"];
// 4 March: a day under 13, so a month-first order cannot hide behind a valid date.
const march = "2026-03-04T15:07:09Z";
const twelveHour = /\b(AM|PM|am|pm)\b|[  ](a|p)\.?m\.?/u;

test("the host's shared formatter writes day-month-year and a 24-hour clock in every locale", () => {
  for (const locale of locales) {
    const format = zurich(locale);
    assert.equal(formatMoment(march, format), "04.03.2026 16:07", locale);
    // The Accounts, Details and metadata rows' short moment.
    assert.equal(
      formatMoment(march, format, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      "04.03.2026 16:07",
      locale,
    );
    // Approvals' and questions' time of day.
    assert.equal(
      formatMoment(march, format, { hour: "numeric", minute: "2-digit", second: "2-digit" }),
      "16:07:09",
      locale,
    );
    assert.equal(
      formatMoment(march, format, { day: "numeric", month: "short", year: "numeric" }),
      "04.03.2026",
      locale,
    );
    assert.doesNotMatch(formatMoment("2026-11-21T19:30:00Z", format), twelveHour, locale);
  }
});

test("midnight reads 00:00, summer time follows the zone and an explicit zone wins", () => {
  const format = zurich("en-US");
  assert.equal(formatMoment("2026-11-21T23:00:00Z", format), "22.11.2026 00:00");
  assert.equal(formatMoment("2026-07-01T12:00:00Z", format), "01.07.2026 14:00");
  assert.equal(
    formatMoment("2026-11-21T23:00:00Z", format, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
    "21.11.2026",
  );
  assert.equal(
    formatMoment(
      march,
      { locale: "en-US", timeZone: "UTC" },
      { dateStyle: "medium", timeStyle: "long" },
    ),
    "04.03.2026 15:07:09 UTC",
  );
});

// The r4 sample clock: 18.11.2026 21:30 in Zurich.
const now = Date.parse("2026-11-18T20:30:00Z");
const weekly = {
  id: "seven_day",
  label: "Weekly",
  observedAt: "2026-11-18T20:26:00Z",
  measure: { unit: "%", remainingRatio: 0.41 },
  period: { mode: "fixed" as const, seconds: 604_800 },
  resetsAt: "2026-11-22T08:05:00Z",
};

test("a window's reset shows its countdown and exact moment as visible text, with no hover title", () => {
  for (const locale of ["en-US", "de-CH"]) {
    const view = windowView(weekly, now, zurich(locale));
    assert.equal(view.reset?.text, "in 3 days · 22.11.2026 09:05", locale);
    assert.equal(view.reset && "title" in view.reset ? view.reset.title : undefined, undefined);
  }
  // Within the day the exact moment still names the date, as every other moment does.
  const soon = windowView(
    { ...weekly, id: "five_hour", resetsAt: "2026-11-18T22:44:00Z" },
    now,
    zurich("en-US"),
  );
  assert.equal(soon.reset?.text, "in 2 h 14 min · 18.11.2026 23:44");
  const due = windowView({ ...weekly, resetsAt: "2026-11-18T19:00:00Z" }, now, zurich("en-US"));
  assert.equal(due.reset?.text, "was due 18.11.2026 20:00");
});

test("Details shows each reset and expiry as its countdown and exact moment", () => {
  const format = zurich("en-US");
  assert.equal(windowView(weekly, now, format).when, "in 3 days · 22.11.2026 09:05");
  const banked = {
    id: "banked-reset-1",
    label: "Weekly resets",
    unit: "resets",
    available: 1,
    observedAt: "2026-11-18T20:26:00Z",
    expiresAt: "2026-11-23T08:00:00Z",
  };
  assert.equal(balanceView(banked, now, format).when, "Expires in 4 days · 23.11.2026 09:00");
  assert.equal(
    balanceView({ ...banked, expiresAt: "2026-11-18T08:00:00Z" }, now, format).when,
    "Expired 18.11.2026 09:00",
  );
});

test("the pool app's moments use the same format, and its cap shows the exact reset", () => {
  assert.equal(exactTime(march), "04.03.2026 16:07");
  assert.doesNotMatch(exactTime("2026-11-21T19:30:00Z"), twelveHour);
  assert.equal(
    resetsIn({ resetAt: "2026-11-22T08:05:00Z" }, now),
    "resets in 3d 11h · 22.11.2026 09:05",
  );
});
