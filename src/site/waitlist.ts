/**
 * The home page's waiting list. One table in the PublicSite Worker's own D1 database: an email
 * address, lowercased, and when it first joined. Nothing is sent to anyone.
 */

/** The part of a D1 binding the list uses, so tests can run the same SQL on local SQLite. */
export interface WaitlistDatabase {
  prepare(query: string): {
    bind(...values: string[]): WaitlistStatement;
  } & WaitlistStatement;
  batch(statements: readonly WaitlistStatement[]): Promise<unknown>;
}
export interface WaitlistStatement {
  run(): Promise<unknown>;
}

/** The part of a Workers rate limit binding the list uses. */
export interface WaitlistRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type JoinResult = "joined" | "invalid" | "limited" | "failed";

// The table creates itself, so the database needs no migration history to start.
const schema =
  "CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID";
// A repeat sign-up keeps the first timestamp and looks the same as a new one.
const insert =
  "INSERT INTO waitlist (email, created_at) VALUES (?1, ?2) ON CONFLICT (email) DO NOTHING";

/** Lowercased and trimmed, or undefined when it can't be an address. */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  // RFC 5321 caps a path at 254 characters; one @, a dot in the domain, no spaces or controls.
  if (
    email.length > 254 ||
    !/^[^\s@\p{Cc}]{1,64}@(?:[^\s@\p{Cc}.]+\.)+[^\s@\p{Cc}.]+$/u.test(email)
  )
    return undefined;
  return email;
}

export interface JoinInput {
  readonly email: unknown;
  /** The hidden field only bots fill in. */
  readonly honeypot: unknown;
  /** Who is asking, for the rate limit; the address itself is never stored. */
  readonly client: string;
}

export async function joinWaitlist(
  { email, honeypot, client }: JoinInput,
  database: WaitlistDatabase,
  rateLimit: WaitlistRateLimit,
  now: () => Date = () => new Date(),
): Promise<JoinResult> {
  if (!(await rateLimit.limit({ key: client })).success) return "limited";
  // A bot that fills the trap sees the same success a person does, and nothing is stored.
  if (typeof honeypot === "string" && honeypot !== "") return "joined";
  const address = normalizeEmail(email);
  if (address === undefined) return "invalid";
  try {
    await database.batch([
      database.prepare(schema),
      database.prepare(insert).bind(address, now().toISOString()),
    ]);
  } catch {
    // Never log the address; the fixed line is enough to find the outage.
    console.error("waitlist: database write failed");
    return "failed";
  }
  return "joined";
}
