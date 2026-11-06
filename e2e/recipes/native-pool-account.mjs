import { Effect } from "effect";

/** Connect on the provider app, then select the saved account through the public pool route. */
export const nativePoolAccount = (h, pool, reference) =>
  Effect.gen(function* () {
    const app = yield* h.request("POST", `${h.prefix}/apps/install`, {
      entry: "provider-openai",
      name: "Synthetic saved pool accounts",
    });
    h.fixture.prepareAcquisition(null, reference, "codex");
    const pending = yield* h.request(
      "POST",
      `${h.appPath(app.id)}/accounts/app/openai/connections`,
      {},
    );
    const path = `${h.prefix}/connections/${pending.id}/interactive`;
    yield* h.request("POST", `${path}/start`, { method: "codex" });
    const saved = yield* h.request("GET", `${path}/status`);
    if (saved.state !== "connected")
      throw new Error("Synthetic provider connection did not complete");
    yield* h.request("PUT", `${h.appPath(pool.id)}/accounts/app/openai/${saved.account.id}`);
    yield* h.request("DELETE", `${h.appPath(app.id)}/accounts/app/openai/${saved.account.id}`);
    yield* Effect.promise(() => h.fixture.reconcile(pool.id));
    return {
      account: saved.account.id,
      reference,
      unlink: `${h.appPath(pool.id)}/accounts/app/openai/${saved.account.id}`,
      remove: `${h.prefix}/accounts/${saved.account.id}`,
    };
  });
