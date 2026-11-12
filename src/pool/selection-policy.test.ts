import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { poolCreditRouting } from "./credit-policy.ts";
import { handleCreditRouting } from "./credit-routing-http.ts";
import { setPoolSelectionPolicy } from "./selection-policy.ts";
import { signEnvelope } from "./token.ts";

function fixture() {
  const groups = [
    {
      id: 1,
      channel_name: "signalbox-pool-one",
      account_selection_policy: "reset_aware",
      usage_credit_policy: "never",
    },
    {
      id: 2,
      channel_name: "signalbox-pool-one",
      account_selection_policy: "reset_aware",
      usage_credit_policy: "never",
    },
    {
      id: 3,
      channel_name: "signalbox-pool-two",
      account_selection_policy: "reset_aware",
      usage_credit_policy: "last_resort",
    },
  ];
  let refuse: number | undefined;
  const calls: string[] = [];
  const home = new HomeClient(async (path, init) => {
    calls.push(path);
    if (path === "/v8/management/channel-groups") return Response.json({ channel_groups: groups });
    const id = Number(path.split("/")[4]);
    const group = groups.find((row) => row.id === id);
    if (group && init?.method === "PATCH") {
      const value = JSON.parse(String(init.body));
      if (group.id !== refuse) group.account_selection_policy = value.account_selection_policy;
      return Response.json({ channel_group: group });
    }
    if (group && path.endsWith("/usage-credit-routing"))
      return Response.json({
        accountSelectionPolicy: group.account_selection_policy,
        usageCreditPolicy: group.usage_credit_policy,
        accounts: {},
      });
    return Response.json({}, { status: 404 });
  });
  return {
    home,
    groups,
    calls,
    refuse: (id: number) => {
      refuse = id;
    },
  };
}

test("selection policy defaults, reverses, remains per pool and preserves credit policy", async () => {
  const f = fixture();
  assert.equal((await poolCreditRouting(f.home, "one")).accountSelectionPolicy, "reset_aware");
  await setPoolSelectionPolicy(f.home, "one", "balanced");
  assert.equal((await poolCreditRouting(f.home, "one")).accountSelectionPolicy, "balanced");
  assert.equal((await poolCreditRouting(f.home, "two")).accountSelectionPolicy, "reset_aware");
  assert.equal((await poolCreditRouting(f.home, "one")).usageCreditPolicy, "never");
  await setPoolSelectionPolicy(f.home, "one", "reset_aware");
  assert.equal((await poolCreditRouting(f.home, "one")).accountSelectionPolicy, "reset_aware");
  f.refuse(2);
  await assert.rejects(setPoolSelectionPolicy(f.home, "one", "balanced"));
  assert.equal(f.groups[0]!.account_selection_policy, "balanced");
  assert.equal(f.groups[1]!.account_selection_policy, "reset_aware");
});

test("signed owner selection changes reject members, invalid values and expired assertions", async () => {
  const f = fixture(),
    signingKey = "ab".repeat(32);
  const invoke = async (user: string, policy: unknown, expiresAt = Date.now() + 25_000) => {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      action: "setSelectionPolicy",
      pool: "one",
      organization: "org",
      owner: "owner",
      user,
      accountSelectionPolicy: policy,
      expiresAt,
    });
    return handleCreditRouting(
      new Request("https://pool.example/pool/v1/setSelectionPolicy", {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
      { home: f.home, signingKey },
    );
  };
  assert.equal((await invoke("member", "balanced")).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await invoke("owner", "fill-first")).status, 400);
  assert.equal((await invoke("owner", "balanced", Date.now() - 1)).status, 401);
  assert.equal((await invoke("owner", "balanced")).status, 200);
  assert.equal((await poolCreditRouting(f.home, "one")).accountSelectionPolicy, "balanced");
});
