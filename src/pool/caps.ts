import { isWeeklyCap, type Cap } from "../../apps/pool/contract.ts";
import { backendUserName, personPrefix } from "./backend-users.ts";
import { ComputerHome } from "./computer-home.ts";
import { type HomeClient, poolGroupPrefix } from "./control.ts";
import { fail, post, rows, unavailable, type Json } from "./json.ts";

/** Only legacy keys still carrying this pool's group delay its cap. Read-only. */
async function pendingUsers(home: HomeClient, pool: string, legacy: Json[]): Promise<Set<unknown>> {
  if (!legacy.length) return new Set();
  const ids = new Set(legacy.map((user) => user.id));
  const [groups, data] = await Promise.all([home.allPoolGroups(), home.data("/access/api-keys")]);
  const groupIds = new Set(groups.filter((group) => group.channel_name === `${poolGroupPrefix}${pool}`).map((group) => group.id));
  return new Set(rows(data.items).filter((key) => ids.has(key.user_id)
    && Array.isArray(key.channels) && key.channels.some((group) => groupIds.has(group))).map((key) => key.user_id));
}

function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

/** Caller holds Computers.run across migration, this guard and the limit write. */
export async function setCap(home: HomeClient, person: string, pool: string, weekly: number | null): Promise<void> {
  if (weekly !== null && !isWeeklyCap(weekly)) {
    return fail(400, "invalid_query", "Enter a weekly cap between $0.01 and $100,000, in whole cents.");
  }
  const legacyName = (await personPrefix(person)).slice(0, -1);
  const legacy = rows((await home.data("/users")).users).filter((user) => user.username === legacyName);
  if ((await pendingUsers(home, pool, legacy)).size)
    return fail(409, "busy", "This person's legacy keys still include this pool. Move or revoke those keys before setting its cap.");
  const id = await new ComputerHome(home).user(person, pool);
  // Home v1.1.6 user_period_limit.go:475-484 sums charges by user. A newly set
  // cap excludes pre-migration spend; charges on the pool user count from its migration.
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

/** Query live totals only for members with an active per-pool cap. Never migrate on reads. */
export async function readCaps(home: HomeClient, pool: string, people: readonly string[]): Promise<Map<string, Cap | null>> {
  const caps = new Map<string, Cap | null>();
  if (!people.length) return caps;
  const users = rows((await home.data("/users")).users);
  const unique = [...new Set(people)];
  const legacyNames = new Map(await Promise.all(unique.map(async (person) => [person, (await personPrefix(person)).slice(0, -1)] as const)));
  const names = new Set(legacyNames.values());
  const legacy = users.filter((user) => names.has(String(user.username)));
  const pending = await pendingUsers(home, pool, legacy);
  const byName = new Map(users.map((user) => [user.username, user]));
  // Bound Home's concurrent usage queries for large owner lists.
  for (let start = 0; start < unique.length; start += 4) {
    await Promise.all(unique.slice(start, start + 4).map(async (person) => {
      const user = byName.get(await backendUserName(person, pool));
      const legacyUser = byName.get(legacyNames.get(person));
      if (legacyUser && pending.has(legacyUser.id)) {
        console.warn("Pool cap not active: legacy keys remain on this pool", { pool, person });
        caps.set(person, null);
        return;
      }
      caps.set(person, !user || user.limit_7d_credits === null ? null : await capForUser(home, user));
    }));
  }
  return caps;
}

export async function readCap(home: HomeClient, person: string, pool: string): Promise<Cap | null> {
  return (await readCaps(home, pool, [person])).get(person) ?? null;
}
