import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mobileController } from "../mobile/controller.ts";

const now = 1_800_000_000_000;
export async function advance(t: TestContext, milliseconds: number) {
  // Tick each millisecond so promise continuations can install their next fake timer.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    t.mock.timers.tick(Math.min(50, milliseconds - elapsed));
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  }
}
export function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  t.mock.method(performance, "now", () => Date.now() - now);
  t.mock.method(Math, "random", () => 0.5);
  let networkChanged: ((online: boolean) => void) | undefined;
  let online = true;
  let status = 200;
  let reads = 0;
  const times: number[] = [];
  let retryAfter: string | undefined;
  let held: Promise<void> | undefined;
  let ignoresAbort = false;
  let refreshHeld: Promise<void> | undefined;
  let refreshReads = 0;
  let rotationWrite: Promise<void> | undefined;
  let storeRead: Promise<void> | undefined;
  let storeReads = 0;
  const signals: AbortSignal[] = [];
  let inFlight = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/") return new Response(null, { status: online ? 200 : 503 });
    if (url.pathname === "/api/auth/oauth2/register")
      return Response.json({ client_id: "fixture-client" });
    if (url.pathname === "/api/auth/oauth2/device-authorization")
      return Response.json({
        device_code: "fixture-device-code",
        user_code: "BCDF-GHJK",
        verification_uri: "https://fixture.example.test/native/device",
        verification_uri_complete: "https://fixture.example.test/native/device?user_code=BCDF-GHJK",
        expires_in: 300,
      });
    if (url.pathname === "/api/auth/oauth2/token") {
      const refresh = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
      if (refresh) {
        refreshReads++;
        await refreshHeld;
      }
      return Response.json({
        access_token: refresh ? "fixture-next-access" : "fixture-signed-in-access",
        refresh_token: refresh ? "fixture-next-refresh" : "fixture-signed-in-refresh",
        token_type: "bearer",
        expires_in: 3600,
        scope: "native offline_access",
      });
    }
    assert.equal(url.pathname, "/api/auth/native/access");
    if (init?.signal) signals.push(init.signal);
    reads++;
    times.push(Date.now());
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    try {
      if (held && ignoresAbort) await held;
      else if (held) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener("abort", abort, { once: true });
          void held!
            .then(resolve, reject)
            .finally(() => init?.signal?.removeEventListener("abort", abort));
          if (init?.signal?.aborted) abort();
        });
      }
      if (!online) throw new TypeError("Synthetic offline network");
      if (status !== 200)
        return new Response(null, {
          status,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        });
      return Response.json({
        id: "native:fixture",
        userId: "fixture-user",
        clientId: "fixture-client",
        policy: {
          kind: "native",
          models: true,
          toolsOrganization: "fixture-tools",
          computer: "fixture-phone",
          pool: "fixture-pool",
        },
        expiresAt: now + 3_600_000,
      });
    } finally {
      inFlight--;
    }
  });
  let saved: string | undefined = JSON.stringify({
    version: 1,
    mode: "device",
    origin: "https://fixture.example.test",
    clientId: "fixture-client",
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: now + 3_600_000,
  });
  const controller = mobileController({
    store: {
      read: async () => {
        storeReads++;
        await storeRead;
        return saved;
      },
      write: async (value) => {
        if (JSON.parse(value).accessToken === "fixture-next-access") await rotationWrite;
        saved = value;
      },
      remove: async () => {
        saved = undefined;
      },
    },
    network: {
      subscribe: (changed) => {
        networkChanged = changed;
        return () => {
          networkChanged = undefined;
        };
      },
    },
    socket: () => {
      throw new Error("No application operation should be replayed");
    },
    crypto: { randomBytes: () => new Uint8Array(32), sha256: async () => new Uint8Array(32) },
    openApproval: async () => {},
    closeApproval: () => {},
  });
  return {
    controller,
    times,
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
    status: (value: number, retry?: string) => {
      status = value;
      retryAfter = retry;
    },
    hold: (value: Promise<void> | undefined) => {
      held = value;
    },
    signals,
    holdStoreRead: (value: Promise<void> | undefined) => {
      storeRead = value;
    },
    storeReads: () => storeReads,
    holdRotationWrite: (value: Promise<void>) => {
      rotationWrite = value;
    },
    rawSaved: () => saved,
    expire: () => {
      saved = JSON.stringify({ ...JSON.parse(saved!), expiresAt: Date.now() + 1000 });
    },
    holdRefresh: (value: Promise<void>) => {
      refreshHeld = value;
    },
    refreshReads: () => refreshReads,
    saved: () => JSON.parse(saved!),
    ignoreAbort: () => {
      ignoresAbort = true;
    },
    notifyNetwork: (value: boolean) => networkChanged?.(value),
    reads: () => reads,
    maximum: () => maximum,
  };
}
