import assert from "node:assert/strict";
import { test } from "node:test";
import { usageForecast } from "./usage-forecast.ts";
import { addUsageDays, usageDayStart } from "./usage-calendar.ts";

const first = "2026-09-14";
const today = "2026-11-09";
const now = "2026-11-09T11:00:00Z";
const history = (weeks: readonly number[], shape = [1, 1, 1, 1, 1, 1, 1]) =>
  weeks.flatMap((total, week) =>
    shape.map((share, day) => ({
      day: addUsageDays(first, week * 7 + day),
      value: (total * share) / shape.reduce((sum, value) => sum + value, 0),
      requests: 500,
    })),
  );

test("four full Zurich weeks supply the median and weekday shape; the partial week never trains", () => {
  const days = [
    ...history([70, 70, 70, 70, 140, 210, 280, 350], [1, 1, 1, 1, 1, 3, 2]),
    { day: today, value: 1000, requests: 500 },
  ];
  const forecast = usageForecast({ days, calculatedAt: now });
  assert.equal(forecast.status, "available");
  if (forecast.status !== "available") return;
  assert.equal(forecast.nextWeek.median, 245);
  assert.equal(forecast.comparableWeeks, 8);
  assert.equal(forecast.trainingWeeks.length, 4);
  assert.equal(forecast.daily.find((day) => day.day === "2026-11-21")?.median, 73.5);
  assert.ok(forecast.thisWeek.median! >= 1000);
  assert.equal(forecast.daily[0]?.day, today);
  assert.equal(forecast.month.through, "2026-12-01");
});

test("back-tests use the same four-week median with only earlier weeks, and ranges use actual misses", () => {
  const forecast = usageForecast({
    days: history([70, 70, 70, 70, 140, 140, 140, 140]),
    calculatedAt: now,
  });
  assert.equal(forecast.status, "available");
  if (forecast.status !== "available") return;
  assert.deepEqual(
    forecast.misses.map((miss) => miss.predicted),
    [70, 70, 105, 140],
  );
  assert.deepEqual(
    forecast.misses.map((miss) => miss.error),
    [70, 70, 35, 0],
  );
  assert.ok(Math.abs(forecast.nextWeek.low! - 70) < 1e-9);
  assert.ok(Math.abs(forecast.nextWeek.high! - 210) < 1e-9);
  assert.equal(forecast.confidence, "Low");
  assert.equal(forecast.interval, 0.8);
});

test("unknown days break a week; missing days are never silently filled with zero", () => {
  const days = history([70, 70, 70, 70]);
  days.splice(4, 1);
  const result = usageForecast({ days, calculatedAt: "2026-10-12T10:00:00Z" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "insufficient-history");
});

test("four observed weeks can produce a Low forecast without inventing an 80% interval", () => {
  const result = usageForecast({
    days: history([70, 70, 70, 70]),
    calculatedAt: "2026-10-12T10:00:00Z",
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.confidence, "Low");
  assert.equal(result.nextWeek.low, null);
  assert.equal(result.nextWeek.high, null);
  assert.equal(result.misses.length, 0);
});

test("sparse history and invalid or duplicate observations withhold a forecast", () => {
  const days = history([70, 70, 70, 70, 70, 70, 70, 70]);
  const reason = (value: ReturnType<typeof usageForecast>) =>
    value.status === "unavailable" ? value.reason : null;
  assert.equal(
    reason(
      usageForecast({ days: days.map((day) => ({ ...day, requests: 1 })), calculatedAt: now }),
    ),
    "insufficient-use",
  );
  assert.equal(
    reason(usageForecast({ days: [...days, days[0]!], calculatedAt: now })),
    "invalid-input",
  );
  assert.equal(
    reason(
      usageForecast({ days: days.map((day) => ({ ...day, value: Infinity })), calculatedAt: now }),
    ),
    "invalid-input",
  );
});

test("future observations cannot train or alter a forecast", () => {
  const days = history([70, 70, 70, 70, 70, 70, 70, 70]);
  assert.deepEqual(
    usageForecast({
      days: [...days, { day: "2026-11-30", value: 1e12, requests: 9000 }],
      calculatedAt: now,
    }),
    usageForecast({ days, calculatedAt: now }),
  );
});

test("Zurich day boundaries retain the spring and autumn DST day lengths", () => {
  assert.equal(usageDayStart("2026-03-29"), Date.parse("2026-03-28T23:00:00Z"));
  assert.equal(usageDayStart("2026-03-30") - usageDayStart("2026-03-29"), 23 * 3_600_000);
  assert.equal(usageDayStart("2026-10-26") - usageDayStart("2026-10-25"), 25 * 3_600_000);
  assert.equal(addUsageDays("2026-03-29", 1), "2026-03-30");
});
