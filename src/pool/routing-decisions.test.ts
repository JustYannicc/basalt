import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { handleCreditRouting } from "./credit-routing-http.ts";
import { signEnvelope } from "./token.ts";
import { routingDecisionsView } from "./routing-decision-view.ts";

const now = new Date().toISOString();
const rawCandidate = (account: string) => ({
  account,
  eligible: true,
  funding: "plan",
  reason: "target-share",
  quota: null,
  targetBurnRate: null,
  weight: 0.5,
  projectedEmptyAt: null,
  emptyProjection: "unavailable",
});
const rawPlan = {
  configuredStrategy: "quota-deadline",
  effectiveStrategy: "quota-deadline",
  mode: "deadline-rate",
  reason: "uncalibrated-demand",
  forecast: null,
  targetThrough: null,
  candidates: [rawCandidate("home-public"), rawCandidate("home-private")],
};
const page = {
  retention: { from: now, through: now, truncated: false, persistence: "runtime" },
  next: null,
  capacity: [],
  current: [
    {
      provider: "claude",
      modelFamily: null,
      scope: "account-windows",
      computedAt: now,
      validUntil: now,
      status: "available",
      plan: rawPlan,
    },
  ],
  decisions: [
    {
      ...rawPlan,
      id: "decision-1",
      at: now,
      model: "opus",
      chosenAccount: "home-private",
      outcome: "admitted",
      attempts: [{ account: "home-private", outcome: "admitted" }],
      usageRecord: "private-request-id",
    },
  ],
};

test("signed owner trace read maps current identities and withholds every private candidate fact", async () => {
  const calls: string[] = [];
  const home = new HomeClient(async (path) => {
    calls.push(path);
    if (path === "/v8/management/channel-groups")
      return Response.json({ channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool" }] });
    if (path.endsWith("/usage-credit-routing"))
      return Response.json({
        accountSelectionPolicy: "reset_aware",
        usageCreditPolicy: "last_resort",
        accounts: {},
      });
    if (path === "/v8/management/channel-groups/1")
      return Response.json({ channel_group: { updated_at: now } });
    if (path.includes("/routing-decisions?")) return Response.json(page);
    return Response.json({}, { status: 404 });
  });
  const signingKey = "ab".repeat(32);
  const invoke = async (user: string) => {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      action: "routingDecisions",
      pool: "pool",
      organization: "org",
      user,
      owner: "owner",
      canEdit: true,
      accounts: [{ account: "visible-account", home: ["home-public"] }],
      expiresAt: Date.now() + 25_000,
    });
    return handleCreditRouting(
      new Request("https://pool.example/pool/v1/routingDecisions", {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
      { home, signingKey },
    );
  };
  assert.equal((await invoke("member")).status, 403);
  assert.equal(calls.length, 0);
  const response = await invoke("owner");
  assert.equal(response.status, 200);
  const text = await response.text(),
    result = JSON.parse(text);
  assert.equal(text.includes("home-private"), false);
  assert.equal(text.includes("home-public"), false);
  assert.equal(text.includes("private-request-id"), false);
  assert.deepEqual(result.decisions[0].candidates[1], { account: null, display: "withheld" });
  assert.deepEqual(result.decisions[0].attempts, []);
  assert.equal(result.decisions[0].chosenAccount, null);
  assert.equal(result.current[0].candidates[0].account, "visible-account");
  assert.deepEqual(
    result.settings.choices.map((item: { strategy: string }) => item.strategy),
    ["quota-deadline", "round-robin"],
  );
});

test("ambiguous or removed mappings never reveal historical account identity", () => {
  const result = routingDecisionsView([page], "balanced", now, [
    { account: "one", home: ["home-public"] },
    { account: "two", home: ["home-public"] },
  ]);
  assert.deepEqual(result.decisions[0]!.candidates, [
    { account: null, display: "withheld" },
    { account: null, display: "withheld" },
  ]);
  assert.equal(result.settings.strategy, "round-robin");
});
