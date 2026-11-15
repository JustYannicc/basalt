import assert from "node:assert/strict";
import { test } from "node:test";
import { runScopedPreviewAcceptance } from "./preview-scoped.ts";
import { scopedPreviewPassed } from "./preview-scoped-result.ts";

const config = {
  origin: "https://app.pr-42.preview.example.invalid",
  organizationId: "stage-org",
  poolAppId: "stage-pool",
  email: "preview@example.invalid",
  password: "fixture-password",
};
const model = { modelUrl: "http://127.0.0.1:45678", modelKey: "local-live-model-nonce" };
function scenario(fault?: string) {
  const calls: string[] = [];
  let computer = 0;
  return {
    calls,
    run: () =>
      runScopedPreviewAcceptance(config, model, {
        client: {
          async signIn() {
            calls.push("sign-in");
          },
          async poolView() {
            return { isOwner: true, accounts: [], providers: [] };
          },
          async claimComputer() {
            const id = `computer-${++computer}`;
            calls.push(`claim-${id}`);
            return {
              id,
              payload: {
                version: 1,
                brand: {
                  name: "Preview",
                  mcpServerName: "preview",
                  setup: { id: "preview", marker: "fixture" },
                },
                instructions: "fixture",
                credentials: {
                  modelUrl: config.origin,
                  modelKey: `stage-model-${id}`,
                  toolsUrl: `${config.origin}/mcp`,
                  toolsToken: `stage-tools-${id}`,
                },
              },
            };
          },
          async waitForToolCall(id) {
            calls.push(`tool-${id}`);
            return { firstToolCallAt: new Date().toISOString() };
          },
          async revokeComputer(id) {
            calls.push(`revoke-${id}`);
            if (fault === "revoke") throw new Error("refused");
          },
          async verifyRevoked(credentials) {
            assert.equal(credentials.modelUrl, config.origin);
            calls.push("verify-revoked");
          },
          async signOut() {
            calls.push("sign-out");
            if (fault === "sign-out") throw new Error("refused");
          },
        },
        native: async (input) => {
          assert.equal(input.payload.credentials.toolsUrl, `${config.origin}/mcp`);
          assert.equal(input.payload.credentials.modelUrl, input.modelOrigin);
          assert.equal(input.model, input.client === "claude" ? "claude-opus-5-5" : "gpt-5.4");
          return {
            async run() {
              calls.push(`run-${input.client}`);
              if (fault === "run") throw new Error("refused");
              return {
                modelReplyMatched: true,
                toolCallObserved: true,
                ...(input.client === "codex" && fault !== "auth"
                  ? ({ chatgptAuthPreserved: true, refreshTokenUntouched: true } as const)
                  : {}),
              };
            },
            async undo() {
              calls.push(`undo-${input.client}`);
              if (fault === "undo") throw new Error("refused");
            },
            async dispose() {
              calls.push(`dispose-${input.client}`);
            },
          };
        },
        fixture: async () => ({
          modelUrl: "http://127.0.0.1:45679",
          modelKey: "local-codex-fixture-nonce",
          authFile: "synthetic-auth.json",
          model: "gpt-5.4",
          evidence: () => ({
            requests: 2,
            toolRequested: true,
            toolResultObserved: true,
            failed: fault === "fixture",
          }),
          async close() {
            calls.push("fixture-close");
          },
        }),
      }),
  };
}

test("scoped preview names live Claude and fixture Codex without selecting provider accounts", async () => {
  const s = scenario();
  const result = await s.run();
  assert.equal(scopedPreviewPassed(result), true);
  assert.deepEqual(
    result.clients.map(({ client, transport }) => ({ client, transport })),
    [
      { client: "claude", transport: "live" },
      { client: "codex", transport: "synthetic" },
    ],
  );
  assert.equal(s.calls.filter((call) => call === "verify-revoked").length, 2);
  assert.equal(s.calls.at(-1), "sign-out");
});
for (const fault of ["run", "auth", "fixture", "undo", "revoke", "sign-out"]) {
  test(`failed ${fault} leaves scoped acceptance red and still cleans owned resources`, async () => {
    const s = scenario(fault);
    const result = await s.run();
    assert.equal(scopedPreviewPassed(result), false);
    assert.ok(s.calls.includes("revoke-computer-1"));
    assert.ok(s.calls.includes("dispose-claude"));
    assert.equal(s.calls.at(-1), "sign-out");
  });
}
