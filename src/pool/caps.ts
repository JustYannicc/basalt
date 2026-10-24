import { isWeeklyCap, type Cap } from "../../apps/pool/contract.ts";
import { backendUserName } from "./backend-users.ts";
import { ComputerHome } from "./computer-home.ts";
import type { HomeClient } from "./control.ts";
import { fail, post, rows, unavailable, type Json } from "./json.ts";

function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

export async function setCap(home: HomeClient, person: string, pool: string, weekly: number | null): Promise<void> {
  if (weekly !== null && !isWeeklyCap(weekly)) {
    return fail(400, "invalid_query", "Enter a weekly cap between $0.01 and $100,000, in whole cents.");
  }
  const id = await new ComputerHome(home).user(person, pool);
  // Home v1.1.6 internal/cluster/management/users.go:39-54, 24-29: null clears the limit.
  await home.data(`/users/${id}`, { ...post({ limit_7d_credits: weekly, window_mode_7d: "calendar",
    timezone: "UTC", week_reset_day: 1, week_reset_hour: 0 }), method: "PATCH" });
}

async function capForUser(home: HomeClient, user: Json): Promise<Cap | null> {
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) return unavailable();
  // Home v1.1.6 internal/cluster/user_period_limit.go:96-119; management/users.go:214-226.
  const status = await home.data(`/users/${user.id}/period-limits`);
  const weekly = rows(status.windows).find((window) => window.id === "7d");
  if (!weekly) return unavailable();
  if (weekly.enabled === false) return null;
  if (weekly.enabled !== true || !nonNegative(weekly.limit) || !nonNegative(weekly.used) || !nonNegative(weekly.remaining)
    || status.timezone !== "UTC" || weekly.mode !== "calendar" || weekly.week_reset_day !== 1 || weekly.week_reset_hour !== 0
    || typeof weekly.reset_at !== "string" || !Number.isFinite(Date.parse(weekly.reset_at))) return unavailable();
  return { weekly: weekly.limit, used: weekly.used, remaining: weekly.remaining, resetAt: weekly.reset_at };
}

/** One user list, then live period totals only for members with a configured cap. */
export async function readCaps(home: HomeClient, pool: string, people: readonly string[]): Promise<Map<string, Cap | null>> {
  const caps = new Map<string, Cap | null>();
  if (!people.length) return caps;
  const users = rows((await home.data("/users")).users);
  const byName = new Map(users.map((user) => [user.username, user]));
  const unique = [...new Set(people)];
  // Bound Home's concurrent usage queries for large owner lists.
  for (let start = 0; start < unique.length; start += 4) {
    await Promise.all(unique.slice(start, start + 4).map(async (person) => {
      const user = byName.get(await backendUserName(person, pool));
      caps.set(person, !user || user.limit_7d_credits === null ? null : await capForUser(home, user));
    }));
  }
  return caps;
}

export async function readCap(home: HomeClient, person: string, pool: string): Promise<Cap | null> {
  return (await readCaps(home, pool, [person])).get(person) ?? null;
}
