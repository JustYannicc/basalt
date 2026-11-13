const dayMs = 86_400_000;
const local = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const usageDay = (at: number) => local.format(at);

export function validUsageDay(day: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  );
}

export function addUsageDays(day: string, count: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * dayMs).toISOString().slice(0, 10);
}

export const usageWeekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
export const usageMonday = (day: string) => addUsageDays(day, -usageWeekday(day));

/** Resolve wall-clock midnight rather than adding 24 hours across a Zurich DST change. */
export function usageDayStart(day: string) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let at = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      clock.formatToParts(at).map((part) => [part.type, part.value]),
    );
    const wall = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    at += target - wall;
  }
  return at;
}
