import assert from "node:assert/strict";
import { test } from "node:test";
import { signInDevice, tokenRequest } from "../connection/device-oauth.ts";
import { nativeFixture } from "./native-fixture.ts";

const nodeFetch = globalThis.fetch;
// The phone's fetch (Expo's, or React Native's own) never infers a form content type for a
// URLSearchParams body. Node's fetch does, so this stand-in reproduces the phone's request.
const phoneFetch: typeof fetch = (input, init) => {
  if (!(init?.body instanceof URLSearchParams)) return nodeFetch(input, init);
  const headers = new Headers(init.headers);
  headers.delete("content-type");
  return nodeFetch(input, { ...init, headers, body: init.body.toString() });
};

test("phone sign-in completes approval polling and refresh with the phone's fetch", async () => {
  const remote = await nativeFixture();
  globalThis.fetch = phoneFetch;
  const signal = new AbortController().signal;
  try {
    let approval: string | undefined;
    const credentials = await signInDevice(remote.origin, {
      signal,
      show: async (url) => {
        approval = url;
        remote.approve();
      },
    });
    assert.equal(approval, `${remote.origin}/native/device?user_code=BCDF-GHJK`);
    const refreshed = await tokenRequest(
      remote.origin,
      {
        grant_type: "refresh_token",
        resource: `${remote.origin}/native`,
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
      },
      signal,
    );
    assert.notEqual(refreshed.refreshToken, credentials.refreshToken);
    assert.equal(remote.counts().refreshes, 1);
  } finally {
    globalThis.fetch = nodeFetch;
    await remote.close();
  }
});
