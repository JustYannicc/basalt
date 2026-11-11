import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { poolCreditRouting, setPoolCreditPolicy } from "./credit-policy.ts";
import { handleCreditRouting } from "./credit-routing-http.ts";
import { signEnvelope } from "./token.ts";

function fixture() {
  const groups = [
    { id: 1, channel_name: "signalbox-pool-pool", usage_credit_policy: "last_resort" },
  ];
  let refuseReadback = false;
  const calls: string[] = [];
  const home = new HomeClient(async (path, init) => {
    calls.push(path);
    if (path === "/v8/management/channel-groups") return Response.json({ channel_groups: groups });
    if (path === "/v8/management/channel-groups/1" && init?.method === "PATCH") {
      const value = JSON.parse(String(init.body));
      if (!refuseReadback) groups[0]!.usage_credit_policy = value.usage_credit_policy;
      return Response.json({ channel_group: groups[0] });
    }
    if (path.endsWith("/usage-credit-routing"))
      return Response.json({
        usageCreditPolicy: groups[0]!.usage_credit_policy,
        accounts: {
          "private-home-id": {
            use: "credits",
            eligible: true,
            reason: "credits_only",
            policy: groups[0]!.usage_credit_policy,
          },
        },
      });
    return Response.json({}, { status: 404 });
  });
  return {
    home,
    calls,
    refuse: () => {
      refuseReadback = true;
    },
  };
}
test("policy save requires exact Home readback and stays per pool", async () => {
  const f = fixture();
  await setPoolCreditPolicy(f.home, "pool", "never");
  assert.equal((await poolCreditRouting(f.home, "pool")).usageCreditPolicy, "never");
  assert.equal((await poolCreditRouting(f.home, "other")).usageCreditPolicy, "last_resort");
  f.refuse();
  await assert.rejects(setPoolCreditPolicy(f.home, "pool", "last_resort"));
  assert.equal((await poolCreditRouting(f.home, "pool")).usageCreditPolicy, "never");
});
test("signed routing read maps only inspected accounts and members cannot mutate", async () => {
  const f = fixture(),
    signingKey = "ab".repeat(32);
  const invoke = async (action: string, extra: Record<string, unknown>) => {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      action,
      pool: "pool",
      organization: "org",
      owner: "owner",
      user: "member",
      expiresAt: Date.now() + 25_000,
      ...extra,
    });
    return handleCreditRouting(
      new Request(`https://pool.example/pool/v1/${action}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
      { home: f.home, signingKey },
    );
  };
  const response = await invoke("accountRouting", {
    canEdit: false,
    accounts: [{ account: "public-account", home: ["private-home-id"] }],
  });
  assert.equal(response.status, 200);
  const value = await response.text();
  assert.equal(value.includes("private-home-id"), false);
  assert.equal(JSON.parse(value).accounts["public-account"].use, "credits");
  const before = f.calls.length;
  assert.equal((await invoke("setCreditPolicy", { usageCreditPolicy: "never" })).status, 403);
  assert.equal(f.calls.length, before);
  assert.equal((await invoke("accountRouting", { canEdit: true, accounts: [] })).status, 400);
});
