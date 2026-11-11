import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./native-client-fixture.ts";
import { command } from "./support.ts";

test("native grant access is shared across thirteen concurrent model operations", async () => {
  let refuse = false;
  const f = await fixture({
    storage: process.platform === "linux" ? "file" : "os",
    services: () => ({ status: refuse ? 401 : 200 }),
  });
  try {
    await f.login();
    await command(["agent", "add", "both", "models", "tools"], f.home);
    const origin = await f.start(),
      token = await f.token();
    const request = async () => {
      const response = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.body?.cancel();
      return response.status;
    };
    const before = f.remote.counts().accessReads;
    assert.deepEqual(await Promise.all(Array.from({ length: 13 }, request)), Array(13).fill(200));
    assert.equal(
      f.remote.counts().accessReads,
      before,
      "A validated grant must cover normal operations.",
    );
    refuse = true;
    assert.equal(await request(), 401);
    refuse = false;
    f.remote.limitedAccess(1);
    const held = f.remote.holdAccess();
    const burst = Promise.all(Array.from({ length: 13 }, request));
    await held.arrived;
    held.release();
    assert.deepEqual(await burst, Array(13).fill(200));
    assert.equal(
      f.remote.counts().accessReads,
      before + 2,
      "An auth refusal must trigger one shared revalidation.",
    );
    const times = f.remote.accessTimes().slice(-2);
    assert.ok(times[1]! - times[0]! >= 950, "Revalidation must honor Retry-After before retrying.");
  } finally {
    await f.close();
  }
});

test("expiry refresh is shared and survives a caller cancellation", async () => {
  const f = await fixture({
    storage: process.platform === "linux" ? "file" : "os",
    services: () => ({ status: 200 }),
  });
  try {
    f.remote.expireNext(120);
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const clock = join(f.home, "clock.now"),
      preload = join(f.home, "clock.mjs");
    const start = Date.now();
    await writeFile(clock, String(start));
    await writeFile(
      preload,
      'import { readFileSync } from "node:fs"; Date.now = () => Number(readFileSync(new URL("./clock.now", import.meta.url), "utf8"));',
    );
    const origin = await f.start(["--import", preload]),
      token = await f.token();
    const headers = { authorization: `Bearer ${token}` };
    const before = f.remote.counts().accessReads;
    f.remote.expireNext(3600);
    const held = f.remote.holdRefresh();
    await writeFile(clock, String(start + 100_000));
    const abort = new AbortController();
    const cancelled = fetch(`${origin}/v1/models`, { headers, signal: abort.signal });
    const rejected = assert.rejects(cancelled, /abort/iu);
    try {
      await held.arrived;
      const siblings = Promise.all(
        Array.from({ length: 13 }, async () => {
          const response = await fetch(`${origin}/v1/models`, { headers });
          await response.body?.cancel();
          return response.status;
        }),
      );
      abort.abort();
      await rejected;
      held.release();
      assert.deepEqual(await siblings, Array(13).fill(200));
      assert.equal(f.remote.counts().refreshes, 1);
      assert.equal(f.remote.counts().accessReads, before + 1);
      const next = await fetch(`${origin}/v1/models`, { headers });
      assert.equal(next.status, 200);
      await next.body?.cancel();
      assert.equal(f.remote.counts().accessReads, before + 1);
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
    } finally {
      held.release();
    }
  } finally {
    await f.close();
  }
});

test("token expiry while throttled renews before the authorization read is retried", async () => {
  let refuse = false;
  const f = await fixture({
    storage: process.platform === "linux" ? "file" : "os",
    services: () => ({ status: refuse ? 401 : 200 }),
  });
  try {
    f.remote.expireNext(120);
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const start = Date.now(),
      clock = join(f.home, "clock.now"),
      preload = join(f.home, "clock.mjs");
    await writeFile(clock, String(start));
    await writeFile(
      preload,
      'import { readFileSync } from "node:fs"; Date.now = () => Number(readFileSync(new URL("./clock.now", import.meta.url), "utf8"));',
    );
    const origin = await f.start(["--import", preload]),
      token = await f.token();
    const get = async () => {
      const response = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.body?.cancel();
      return response.status;
    };
    refuse = true;
    assert.equal(await get(), 401);
    refuse = false;
    f.remote.expireNext(3600);
    f.remote.limitedAccess(1);
    const limit = f.remote.nextAccessLimit();
    const pending = get();
    await limit;
    f.remote.expireAccess();
    await writeFile(clock, String(start + 200_000));
    assert.equal(
      await pending,
      200,
      "The throttle must not force sign-in with valid refresh credentials.",
    );
    assert.equal(f.remote.counts().refreshes, 1);
    assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
  } finally {
    await f.close();
  }
});
