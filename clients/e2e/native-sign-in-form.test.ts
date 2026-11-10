import assert from "node:assert/strict";
import { test } from "node:test";
import { signInDevice } from "../connection/device-oauth.ts";
import { nativeFixture } from "./native-fixture.ts";

const nodeFetch = globalThis.fetch;
// React Native's fetch sends a URLSearchParams body as text/plain unless the caller names the
// content type. Node's fetch infers it, so this stand-in reproduces the phone's request.
const reactNativeFetch: typeof fetch = (input, init) => {
  if (!(init?.body instanceof URLSearchParams)) return nodeFetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
  return nodeFetch(input, { ...init, headers, body: init.body.toString() });
};

test("phone sign-in reaches browser approval with React Native's fetch", async () => {
  const remote = await nativeFixture();
  globalThis.fetch = reactNativeFetch;
  const controller = new AbortController();
  let approval: string | undefined;
  try {
    await assert.rejects(
      signInDevice(remote.origin, {
        signal: controller.signal,
        show: async (url) => {
          approval = url;
          controller.abort(new Error("Approval reached."));
        },
      }),
    );
    assert.equal(approval, `${remote.origin}/native/device?user_code=BCDF-GHJK`);
  } finally {
    globalThis.fetch = nodeFetch;
    await remote.close();
  }
});
