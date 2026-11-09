import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleSite, type SiteEnv } from "./worker.ts";
import { normalizeEmail, type WaitlistDatabase } from "./waitlist.ts";

/** D1 runs SQLite, so the list's own SQL runs here unchanged. */
function sqlite(): { database: WaitlistDatabase; rows: () => Record<string, unknown>[] } {
  const db = new DatabaseSync(":memory:");
  const statement = (query: string, values: string[] = []) => ({
    bind: (...next: string[]) => statement(query, next),
    run: async () => db.prepare(query).run(...values),
  });
  return {
    database: {
      prepare: (query) => statement(query),
      // D1 batches run in one transaction.
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          for (const item of statements) await item.run();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    rows: () => {
      try {
        return db.prepare("SELECT email, created_at FROM waitlist ORDER BY email").all();
      } catch {
        return [];
      }
    },
  };
}

/** The Workers binding allows `limit` calls per key per period; the test never lets time pass. */
function rateLimit(limit = 5) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    limit: async ({ key }: { key: string }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= limit };
    },
  };
}

function site(limit?: number) {
  const store = sqlite();
  const limiter = rateLimit(limit);
  const env: SiteEnv = { WAITLIST: store.database, WAITLIST_LIMIT: limiter };
  const post = (
    fields: Record<string, string>,
    init: { ip?: string; origin?: string | null } = {},
  ) =>
    handleSite(
      new Request("https://signalbox.run/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": init.ip ?? "192.0.2.1",
          ...(init.origin === null ? {} : { Origin: init.origin ?? "https://signalbox.run" }),
        },
        body: new URLSearchParams({ leave_empty: "", ...fields }),
      }),
      env,
    );
  return { env, post, rows: store.rows, limiter };
}

test("a sign-up is stored lowercased with its time and answered with the joined line", async () => {
  const { post, rows } = site();
  const response = await post({ email: "  Ada@Example.COM " });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /You're on the list\./);
  assert.doesNotMatch(html, /<form/);
  const [row, ...rest] = rows();
  assert.equal(rest.length, 0);
  assert.equal(row?.email, "ada@example.com");
  assert.ok(!Number.isNaN(Date.parse(String(row?.created_at))));
});

test("visiting the form's address without posting shows the form, never the joined line", async () => {
  const { env } = site();
  for (const path of ["/waitlist", "/waitlist/"]) {
    const response = await handleSite(new Request(`https://signalbox.run${path}`), env);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /<form class="join" method="post" action="\/waitlist">/, path);
    assert.doesNotMatch(html, /You're on the list/, path);
  }
});

test("signing up again keeps one row and the first time, and answers exactly as the first did", async () => {
  const { post, rows } = site();
  const first = await post({ email: "ada@example.com" });
  const before = rows();
  const again = await post({ email: "ADA@example.com" }, { ip: "192.0.2.2" });
  assert.deepEqual(rows(), before);
  assert.equal(again.status, first.status);
  assert.deepEqual([...again.headers], [...first.headers]);
  assert.equal(await again.text(), await first.text());
});

test("an invalid address is refused with the form and a message, and nothing is stored", async () => {
  const { post, rows } = site(10);
  for (const email of [
    "",
    "ada",
    "ada@example",
    "a b@example.com",
    "ada@@example.com",
    `${"a".repeat(250)}@x.io`,
  ]) {
    const response = await post({ email });
    assert.equal(response.status, 400, email);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /That doesn't look like an email address/);
    assert.match(html, /<form class="join" method="post" action="\/waitlist">/);
  }
  assert.deepEqual(rows(), []);
});

test("a filled trap field looks like success to the bot and stores nothing", async () => {
  const { post, rows } = site();
  const response = await post({ email: "bot@example.com", leave_empty: "https://spam.example" });
  assert.deepEqual(rows(), []);
  const real = await post({ email: "ada@example.com" }, { ip: "192.0.2.9" });
  assert.equal(response.status, real.status);
  assert.deepEqual([...response.headers], [...real.headers]);
  assert.equal(await response.text(), await real.text());
});

test("each IP gets a few tries per period, counted before anything else, and others are unaffected", async () => {
  const { post, rows, limiter } = site(2);
  assert.equal((await post({ email: "one@example.com" })).status, 200);
  assert.equal((await post({ email: "nope" })).status, 400);
  const limited = await post({ email: "three@example.com" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.match(await limited.text(), /Too many tries from here/);
  assert.equal((await post({ email: "four@example.com" }, { ip: "198.51.100.7" })).status, 200);
  assert.deepEqual(
    rows().map((row) => row.email),
    ["four@example.com", "one@example.com"],
  );
  assert.deepEqual([...limiter.keys.keys()], ["192.0.2.1", "198.51.100.7"]);
});

test("only same-origin form posts reach the list", async () => {
  const { post, env, rows } = site();
  assert.equal(
    (await post({ email: "ada@example.com" }, { origin: "https://evil.example" })).status,
    403,
  );
  // Browsers may omit Origin on a same-site navigation; the form still works.
  assert.equal((await post({ email: "ada@example.com" }, { origin: null })).status, 200);
  const json = await handleSite(
    new Request("https://signalbox.run/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@example.com" }),
    }),
    env,
  );
  assert.equal(json.status, 415);
  const large = await post({ email: "big@example.com", leave_empty: "", pad: "x".repeat(4096) });
  assert.equal(large.status, 413);
  assert.deepEqual(
    rows().map((row) => row.email),
    ["ada@example.com"],
  );
  assert.equal(
    (await handleSite(new Request("https://signalbox.run/", { method: "POST" }), env)).status,
    405,
  );
});

test("a body with no declared length is still capped, and a trailing slash posts the same form", async () => {
  const { env, rows } = site();
  const stream = (text: string) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  const chunked = (path: string, text: string) =>
    handleSite(
      new Request(`https://signalbox.run${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: stream(text),
        duplex: "half",
      } as RequestInit),
      env,
    );
  assert.equal(
    (await chunked("/waitlist", `email=big%40example.com&pad=${"x".repeat(4096)}`)).status,
    413,
  );
  assert.equal((await chunked("/waitlist/", "email=ada%40example.com&leave_empty=")).status, 200);
  assert.deepEqual(
    rows().map((row) => row.email),
    ["ada@example.com"],
  );
});

test("a database failure keeps the form, says to try again, and never echoes the address", async () => {
  const env: SiteEnv = {
    WAITLIST: {
      prepare: () => ({ bind: () => ({ run: async () => {} }), run: async () => {} }),
      batch: async () => {
        throw new Error("D1_ERROR: storage unavailable");
      },
    },
    WAITLIST_LIMIT: { limit: async () => ({ success: true }) },
  };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const response = await handleSite(
      new Request("https://signalbox.run/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=ada%40example.com&leave_empty=",
      }),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /We couldn't save that just now/);
    assert.match(html, /<form class="join"/);
    assert.doesNotMatch(html, /ada@example\.com|D1_ERROR/);
    assert.doesNotMatch(JSON.stringify(errors), /ada@example\.com/);
  } finally {
    console.error = original;
  }
});

test("a failing rate limit check answers like a storage failure and stores nothing", async () => {
  const { env, rows } = site();
  const original = console.error;
  console.error = () => {};
  try {
    const response = await handleSite(
      new Request("https://signalbox.run/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=ada%40example.com&leave_empty=",
      }),
      {
        ...env,
        WAITLIST_LIMIT: {
          limit: async () => {
            throw new Error("rate limit unavailable");
          },
        },
      },
    );
    assert.equal(response.status, 503);
    assert.match(await response.text(), /We couldn't save that just now/);
    assert.deepEqual(rows(), []);
  } finally {
    console.error = original;
  }
});

test("addresses are trimmed and lowercased, and only plausible ones pass", () => {
  assert.equal(
    normalizeEmail(" Ada.Lovelace+list@Example.co.uk "),
    "ada.lovelace+list@example.co.uk",
  );
  for (const value of [
    undefined,
    null,
    42,
    "ada@",
    "@example.com",
    "ada@example.",
    "ada@exa mple.com",
    "ada@example..com",
    "ada@.example.com",
    "ada\u0000@example.com",
  ])
    assert.equal(normalizeEmail(value), undefined, String(value));
});
