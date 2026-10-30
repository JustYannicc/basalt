import assert from "node:assert/strict";
import { test } from "node:test";
import { redactFeedbackText } from "../../.upstream/packages/ui/src/implementation/lib/feedback-log.ts";
import { redactLogText } from "../../src/feedback/logs.ts";

// The page redacts logs as it records them and the feedback endpoint redacts them again; both
// must agree, and the second pass must leave already-redacted text alone.
const corpus = [
  "TypeError: x at https://app.example.invalid/a?token=raw-query#frag",
  "Request failed /api/apps/foo:bar?token=raw-colon-query",
  JSON.stringify({ headers: { cookie: "theme=dark; sid=raw-session", authorization: "Token raw-auth", "x-api-key": "k3y" } }),
  "Authorization: Bearer abcdefghijklmnop and basic dXNlcjpwYXNzd29yZA==",
  "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here",
  "keys sk-live-1234567890abcdef sb_0123456789abcdef ghp_abcdefghijklmnop1234",
  "mail person@example.invalid and /api/users/person%40example.invalid",
  "password=hunter2 secret: shh client_secret=\"raw-client\" token=raw-token",
  "hex 0123456789abcdef0123456789abcdef01 and base64 QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefAB",
  "plain words, a long-but-harmless-slug-without-digits-in-it and /org/acme/apps stay",
];

test("the page and the feedback endpoint redact logs the same way", () => {
  for (const text of corpus) assert.equal(redactLogText(text), redactFeedbackText(text), text);
});

test("redacting twice changes nothing", () => {
  for (const text of corpus) assert.equal(redactLogText(redactLogText(text)), redactLogText(text), text);
});

test("no secret in the corpus survives", () => {
  const redacted = corpus.map(redactLogText).join("\n");
  assert.doesNotMatch(
    redacted,
    /raw-query|frag|raw-colon-query|raw-session|raw-auth|k3y|abcdefghijklmnop|dXNlcjpw|eyJhbGci|sk-live|sb_0123|ghp_|person@|person%40|hunter2|shh|raw-client|raw-token|0123456789abcdef0123/,
  );
  assert.match(redacted, /long-but-harmless-slug-without-digits-in-it and \/org\/acme\/apps stay/);
});
