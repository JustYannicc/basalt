import assert from "node:assert/strict";
import { test } from "node:test";
import { answerEvidence } from "../../.upstream/e2e/support/answer-evidence.ts";

// Planted values built from parts, so the source names no string a secret scanner would flag.
const plantedToken = ["planted", "token", "0123456789abcdef"].join("_");
const plantedBearer = `Bearer ${["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"].join(".")}`;

test("an app's answer kept as public evidence keeps its shape and words, and cuts links and tokens", () => {
  assert.deepEqual(
    answerEvidence({
      ok: false,
      state: "choice_required",
      message: "The earlier decision for this exact request still applies",
      attempt: 2,
      approval: {
        url: "https://cloud.test/approvals/0b9a8c7d6e5f4a3b2c1d",
        // Short enough to be no token: only the link rule cuts it.
        link: "https://h.test/a",
        token: plantedToken,
        target: { accountId: "000000000003", roleName: "AppOperator3", production: true },
      },
      notes: ["pending", plantedBearer],
      reason: null,
    }),
    {
      ok: false,
      state: "choice_required",
      message: "The earlier decision for this exact request still applies",
      attempt: 2,
      approval: {
        url: "[cut]",
        link: "[cut]",
        token: "[cut]",
        target: { accountId: "000000000003", roleName: "AppOperator3", production: true },
      },
      notes: ["pending", "[cut]"],
      reason: null,
    },
  );
  assert.equal(answerEvidence("plain words stay"), "plain words stay");
  assert.equal(answerEvidence(undefined), undefined);
});
