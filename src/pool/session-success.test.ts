import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { digest } from "./backend-users.ts";
import { sessionSuccess } from "./model-history/session-success.ts";

test("session proof requires both the authorized saved account and the exact successful session", async () => {
  const session = crypto.randomUUID(),
    source = await digest("home-local-v1"),
    at = new Date().toISOString();
  const history = await digest(JSON.stringify([source, "account", "raw-ref"]));
  const authority = {
    canManage: true,
    mappingProven: true,
    accounts: [{ account: "acc_visible", history: [history] }],
  };
  for (const [reference, actualSession, expected] of [
    ["raw-ref", session, at],
    ["other-ref", session, null],
    ["raw-ref", crypto.randomUUID(), null],
  ] as const) {
    const home = new HomeClient(async () =>
      Response.json({
        total: 1,
        items: [
          {
            session_id: actualSession,
            status: "success",
            timestamp: at,
            credential: { credential_id: reference },
          },
        ],
      }),
    );
    const result = await sessionSuccess(home, { accounts: ["acc_visible"], session }, authority);
    assert.deepEqual(result.accounts, [{ account: "acc_visible", lastSuccessAt: expected }]);
    assert.ok(!JSON.stringify(result).includes("raw-ref"));
  }
  await assert.rejects(
    sessionSuccess(
      new HomeClient(async () => {
        throw new Error("must not read");
      }),
      { accounts: ["acc_hidden"], session },
      authority,
    ),
  );
});
