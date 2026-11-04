/** Only the external Home/provider replies are synthetic; no request leaves this fixture. */
export function resetProvider(now) {
  const accounts = new Map();
  const calls = [];
  let held;
  const json = (value) => Response.json(value);
  const reply = (body, status = 200) => json({ status_code: status, body: JSON.stringify(body) });
  const credits = (account) => account.credits.map((credit) => ({ ...credit }));
  return {
    seed(id, provider = "codex", count = 2) {
      if (provider !== "codex" && provider !== "claude")
        throw new Error("Unsupported synthetic reset provider");
      accounts.set(id, {
        provider,
        mode: "reset",
        usable: true,
        receipts: new Map(),
        credits: Array.from({ length: count }, (_, i) => ({
          id: `synthetic-credit-${i + 1}`,
          expiresAt: new Date(now() + (i + 1) * 86_400_000).toISOString(),
          remaining: 1,
        })),
      });
    },
    mode(id, mode) {
      if (!["reset", "unknown", "refused"].includes(mode))
        throw new Error("Unknown synthetic reset mode");
      accounts.get(id).mode = mode;
    },
    usable(id, value) {
      accounts.get(id).usable = value;
    },
    hold() {
      if (held) throw new Error("A synthetic reset is already held");
      let enter, release;
      const started = new Promise((resolve) => {
        enter = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      held = { enter, released, release };
      return { started, release };
    },
    calls,
    remaining(id) {
      return credits(accounts.get(id)).reduce((sum, credit) => sum + credit.remaining, 0);
    },
    balances(id) {
      const account = accounts.get(id);
      if (!account) return null;
      return {
        available_count: this.remaining(id),
        observed_at: new Date(now()).toISOString(),
        credits: credits(account).map((credit) => ({
          id: credit.id,
          status: credit.remaining > 0 ? "available" : "used",
          reset_type: "codex_rate_limits",
          expires_at: credit.expiresAt,
        })),
      };
    },
    async home(route, init, url) {
      if (route === "/credentials/download") {
        const id = url.searchParams.get("id");
        if (!accounts.has(id)) return undefined;
        return json({ type: "codex", account_id: "synthetic-workspace" });
      }
      if (route === "/quota/collect") {
        const body = JSON.parse(init.body);
        calls.push({ action: "collect", ids: body.credential_ids });
        return json({ accepted: body.credential_ids.length });
      }
      if (/^\/credentials\/[^/]+\/cooldown$/.test(route)) {
        calls.push({ action: "clear", id: decodeURIComponent(route.split("/")[2]) });
        return json({ cleared: true });
      }
      if (route !== "/requests/api-call") return undefined;
      const body = JSON.parse(init.body),
        id = body.auth_index;
      const account = accounts.get(id);
      if (!account) return json({}, { status: 404 });
      const target = new URL(body.url);
      if (target.hostname !== (account.provider === "codex" ? "chatgpt.com" : "api.anthropic.com"))
        throw new Error("Unexpected synthetic provider URL");
      if (target.pathname.endsWith("/profile"))
        return reply({ organization: { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });
      if (body.method === "GET") {
        calls.push({ action: "catalog", id });
        return account.provider === "codex"
          ? reply({
              credits: credits(account).map((credit) => ({
                id: credit.id,
                reset_type: "codex_rate_limits",
                status: credit.remaining ? "available" : "used",
                expires_at: credit.expiresAt,
              })),
            })
          : reply({
              cedar_ember: {
                eligible: true,
                at_limit: true,
                cooldown_until: null,
                grants: credits(account).map((credit) => ({
                  id: credit.id,
                  resets_left: credit.remaining,
                  starts_at: null,
                  ends_at: credit.expiresAt,
                  paused: false,
                  usable_now: account.usable,
                  use_requires_limit: true,
                  clears: ["seven_day"],
                })),
              },
            });
      }
      const input = JSON.parse(body.data);
      const requestId = input.redeem_request_id ?? input.request_id,
        creditId = input.credit_id ?? input.grant_id;
      calls.push({ action: "consume", id, requestId, creditId });
      if (held) {
        const gate = held;
        gate.enter();
        await gate.released;
        if (held === gate) held = undefined;
      }
      if (account.receipts.has(requestId)) {
        if (account.receipts.get(requestId) !== creditId) return reply({}, 409);
        return reply(
          account.provider === "codex" ? { code: "already_redeemed" } : { result: "already_used" },
        );
      }
      if (account.mode === "refused")
        return reply(
          account.provider === "codex" ? { code: "nothing_to_reset" } : { result: "not_limited" },
        );
      const credit = account.credits.find(
        (credit) => credit.id === creditId && credit.remaining > 0,
      );
      if (!credit)
        return reply(
          account.provider === "codex" ? { code: "no_credit" } : { result: "ineligible" },
        );
      credit.remaining--;
      account.receipts.set(requestId, creditId);
      if (account.mode === "unknown") return reply({}, 502);
      return reply(account.provider === "codex" ? { code: "reset" } : { result: "reset" });
    },
    stop() {
      held?.release();
      held = undefined;
    },
  };
}
