import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadFailure, uploadResponseDiagnostic } from "./upload-failure.ts";

test("an unknown Cloudflare upload error retains useful bounded text without credentials or source details", () => {
  const diagnostic = uploadResponseDiagnostic(
    400,
    {
      success: false,
      errors: [
        {
          code: 100312,
          message:
            "An unknown error has occurred. token=synthetic-private-token https://private.invalid/upload?email=owner@example.invalid source: export default privateValue",
        },
      ],
      bindings: { PRIVATE: "must-not-be-serialized" },
    },
    ["synthetic-private-token"],
  );
  const failure = uploadFailure(new Error("untrusted raw SDK text"), "McpServer", diagnostic);
  const changed = new Map(
    failure.delta?.changed.map((row) => [row.path, "new" in row ? row.new : null]),
  );
  assert.equal(changed.get("$upload.codes"), "100312");
  assert.equal(changed.get("$upload.messageClass"), "asset-completion-token-consumed");
  assert.equal(changed.get("$upload.bodyClass"), "cloudflare-errors-json");
  assert.match(String(changed.get("$upload.message")), /An unknown error has occurred/);
  assert.match(String(changed.get("$upload.message")), /\[redacted-source\]/);
  assert.match(String(changed.get("$upload.bodyExcerpt")), /100312/);
  const text = JSON.stringify(failure);
  for (const secret of [
    "synthetic-private-token",
    "private.invalid",
    "owner@example.invalid",
    "privateValue",
    "must-not-be-serialized",
    "untrusted raw SDK text",
  ])
    assert.ok(!text.includes(secret), secret);
  assert.ok(String(changed.get("$upload.message")).length <= 512);
  assert.ok(String(changed.get("$upload.bodyExcerpt")).length <= 1024);
});

test("HTML and plain-text upload refusals retain separate body classes", () => {
  for (const [body, bodyClass] of [
    [
      "<!doctype html><html><body>Cloudflare temporarily unavailable https://private.invalid</body></html>",
      "html",
    ],
    ["Upstream unavailable. Bearer synthetic-private-token", "text"],
  ]) {
    const diagnostic = uploadResponseDiagnostic(503, body, ["synthetic-private-token"]);
    assert.equal(diagnostic.bodyClass, bodyClass);
    assert.ok(!JSON.stringify(diagnostic).includes("private.invalid"));
    assert.ok(!JSON.stringify(diagnostic).includes("synthetic-private-token"));
  }
});
