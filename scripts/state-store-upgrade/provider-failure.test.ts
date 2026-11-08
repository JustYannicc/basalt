import assert from "node:assert/strict";
import { test } from "node:test";
import { envelopeFailure, responseFailure } from "./provider-failure.ts";

test("provider diagnostics retain causes while dropping credentials, private identifiers and extra fields", () => {
  const token = "synthetic-sensitive-token";
  const result = envelopeFailure(
    {
      errors: [
        {
          code: 10021,
          message: `Invalid metadata. ${token} Bearer other-secret https://private.invalid/path person@example.invalid api_key=short-value ${"a".repeat(32)}\n<script>`,
          headers: { Authorization: token },
        },
      ],
      messages: ["Check metadata.bindings[2].type."],
      result: { token },
    },
    token,
  );
  const text = JSON.stringify(result);
  assert.equal(result.errors[0]?.code, 10021);
  assert.match(text, /Invalid metadata/);
  assert.match(text, /metadata.bindings\[2\].type/);
  for (const value of [
    token,
    "other-secret",
    "private.invalid",
    "person@",
    "short-value",
    "a".repeat(32),
    "Authorization",
    "<script>",
  ])
    assert.ok(!text.includes(value));
});

test("diagnostics bound each message and entry count", () => {
  const result = envelopeFailure(
    {
      errors: Array.from({ length: 12 }, () => ({
        code: 10021,
        message: "bad metadata. ".repeat(1000),
      })),
    },
    "",
  );
  assert.equal(result.errors.length, 8);
  assert.equal(result.omitted, 4);
  assert.ok(result.errors.every((row) => row.message.length <= 512));
});

test("quoted credential fields and cookie header forms do not enter diagnostics", () => {
  const result = envelopeFailure(
    {
      errors: [
        {
          code: 10021,
          message:
            'Invalid metadata. {"password":"short-value"} "token":"short-token" Cookie: session=tiny; another=other-tiny',
        },
      ],
    },
    "",
  );
  const text = JSON.stringify(result);
  assert.match(text, /Invalid metadata/);
  for (const value of ["short-value", "session=", "other-tiny", "short-token", "Cookie:"])
    assert.ok(!text.includes(value));
});

test("escaped quotes cannot end credential redaction early", () => {
  for (const key of ["password", "token", "authorization", "cookie"]) {
    for (const prefix of ["prefix", "Bearer prefix", "https://example.test/", "file:///private/"]) {
      const quoted = JSON.stringify({ [key]: prefix + '"synthetic-tail\\end' });
      const result = envelopeFailure(
        { errors: [{ code: 10021, message: "Invalid metadata. " + quoted }] },
        "",
      );
      assert.match(result.errors[0]!.message, /Invalid metadata/);
      for (const value of ["prefix", "synthetic-tail", "end"])
        assert.ok(!JSON.stringify(result).includes(value));
    }
  }
});

test("compound credential fields never enter provider diagnostics", () => {
  for (const key of [
    "access_token",
    "refresh_token",
    "client_secret",
    "accessToken",
    "clientSecret",
    "service-api-key",
  ]) {
    const value = "synthetic-short";
    const result = envelopeFailure(
      {
        errors: [{ code: 10021, message: "Invalid metadata. " + JSON.stringify({ [key]: value }) }],
        messages: [`Rejected ${key}='${value}'`],
      },
      "different-request-token",
    );
    assert.equal(result.errors[0]?.code, 10021);
    assert.match(result.errors[0]!.message, /Invalid metadata/);
    assert.match(result.messages[0]!.message, /Rejected/);
    assert.ok(!JSON.stringify(result).includes(value), `${key} must be redacted`);
  }
});

test("non-JSON, oversized and failed body streams have explicit safe diagnoses", async () => {
  assert.equal(
    (await responseFailure(new Response("<html>private text</html>"), "")).body,
    "invalid-json",
  );
  assert.equal((await responseFailure(new Response("x".repeat(65_537)), "")).body, "too-large");
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new Error("private transport detail"));
    },
  });
  const result = await responseFailure(new Response(broken), "");
  assert.equal(result.body, "unavailable");
  assert.ok(!JSON.stringify(result).includes("private transport detail"));
});
