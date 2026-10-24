import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { verifyPoolToken } from "../../src/pool/token.ts";
import { credentialSecretNames, maxExportBytes } from "./constants.ts";
import {
  CredentialExportFailure,
  exportPreviewCredentials,
  safeCredentialExportMessage,
  type ExportInputs,
} from "./export.ts";

const signingKey = "ab".repeat(32);
const claudeJson = ' { "type": "claude", "access_token": "claude-fixture" }\n';
const codexJson = '{"type":"codex","access_token":"codex-fixture"}';

function inputs(overrides: Partial<ExportInputs> = {}): ExportInputs {
  return {
    ref: "refs/heads/main",
    eventName: "workflow_dispatch",
    dedicatedThrowawayAccounts: "true",
    poolId: "app_01234567-89ab-cdef-0123-456789abcdef",
    organizationId: "org_opaque_operator_value",
    ownerId: "user_opaque_operator_value",
    claudeAccountId: "account_claude_exact",
    codexAccountId: "account_codex_exact",
    signingKey,
    releaseToken: "release-token-fixture",
    repository: "owner/repository",
    ...overrides,
  };
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("dispatch, main ref, and explicit throwaway confirmation gate all exports", async () => {
  for (const override of [
    { ref: "refs/heads/feature" },
    { eventName: "push" },
    { dedicatedThrowawayAccounts: "false" },
  ]) {
    let requests = 0;
    let writes = 0;
    await assert.rejects(
      exportPreviewCredentials(inputs(override), {
        fetch: async () => { requests++; return response(claudeJson); },
        writeSecret: async () => { writes++; },
      }),
      (error: unknown) => error instanceof CredentialExportFailure && error.kind !== "export" && error.kind !== "secret",
    );
    assert.equal(requests, 0);
    assert.equal(writes, 0);
  }
});

test("exports the two exact accounts with signed claims and writes only the two preview secrets", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const writes: Array<{ name: string; value: string; token: string; repository: string }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const headers = new Headers(init.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    assert.ok(bearer);
    assert.deepEqual(await verifyPoolToken(signingKey, bearer), {
      pool: "app_01234567-89ab-cdef-0123-456789abcdef",
      organization: "org_opaque_operator_value",
      owner: "user_opaque_operator_value",
    });
    assert.equal(headers.get(callerHeader), "user_opaque_operator_value");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (url.search === "?provider=claude") return response(claudeJson);
    if (url.search === "?provider=codex") return response(codexJson);
    throw new Error("Unexpected endpoint query");
  };

  await exportPreviewCredentials(inputs(), {
    fetch: fetcher,
    writeSecret: async (name, value, token, repository) => { writes.push({ name, value, token, repository }); },
  });

  assert.deepEqual(requests.map(({ url }) => [url.origin, url.pathname, url.search]), [
    [`https://${brand.host}`, "/pool/v1/accounts/account_claude_exact/export", "?provider=claude"],
    [`https://${brand.host}`, "/pool/v1/accounts/account_codex_exact/export", "?provider=codex"],
  ]);
  assert.deepEqual(writes, [
    { name: credentialSecretNames.claude, value: claudeJson, token: "release-token-fixture", repository: "owner/repository" },
    { name: credentialSecretNames.codex, value: codexJson, token: "release-token-fixture", repository: "owner/repository" },
  ]);
});

test("validates both exports before the first secret write", async () => {
  let writes = 0;
  await assert.rejects(
    exportPreviewCredentials(inputs(), {
      fetch: async (input) => new URL(String(input)).search === "?provider=claude"
        ? response(claudeJson)
        : response('{"type":"claude"}'),
      writeSecret: async () => { writes++; },
    }),
    (error: unknown) => safeCredentialExportMessage(error) === "Credential export failed. No credentials were written.",
  );
  assert.equal(writes, 0);
});

test("membership, HTTP, provider type, redirect, invalid JSON, and size failures do not write secrets", async () => {
  const cases: Array<{ name: string; fetch: typeof fetch }> = [
    { name: "wrong membership", fetch: async () => response('{"error":"not_found"}', 404) },
    { name: "HTTP failure", fetch: async () => response("private upstream failure", 503) },
    { name: "wrong provider type", fetch: async () => response('{"type":"codex"}') },
    { name: "redirect refusal", fetch: async () => { throw new Error("private redirect URL and account id"); } },
    { name: "invalid JSON", fetch: async () => response("private invalid body") },
    { name: "oversize body", fetch: async () => response(" ".repeat(maxExportBytes + 1)) },
    { name: "GitHub secret size cap", fetch: async (input) => new URL(String(input)).search === "?provider=claude"
      ? response(`{"type":"claude","data":"${"x".repeat(48 * 1024)}"}`)
      : response(codexJson) },
  ];

  for (const scenario of cases) {
    let writes = 0;
    await assert.rejects(
      exportPreviewCredentials(inputs(), {
        fetch: scenario.fetch,
        writeSecret: async () => { writes++; },
      }),
      (error: unknown) => {
        const message = safeCredentialExportMessage(error);
        assert.equal(message, "Credential export failed. No credentials were written.");
        assert.equal(message.includes("private"), false);
        assert.equal(message.includes("account_claude_exact"), false);
        assert.equal(message.includes("redirect URL"), false);
        return true;
      },
      scenario.name,
    );
    assert.equal(writes, 0, scenario.name);
  }
});

test("unexpected errors become one fixed message without their details", () => {
  const message = safeCredentialExportMessage(new Error("private URL, raw response and account id"));
  assert.equal(message, "Credential export failed. No credentials were written.");
  assert.equal(message.includes("private"), false);
  assert.equal(message.includes("account id"), false);
});
