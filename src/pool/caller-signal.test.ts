import assert from "node:assert/strict";
import { test } from "node:test";
import { followsCaller } from "./caller-signal.ts";
import { runtimeCallerSignal } from "./runtime-slots/transport.ts";
import { appModelPath } from "./app-model-contract.ts";
import { nativeControlPath, nativeSessionPath } from "./native-contract.ts";

const leaving = (url: string, headers: Record<string, string> = {}) => {
  const caller = new AbortController();
  const request = new Request(url, { method: "POST", headers, body: "{}", signal: caller.signal });
  return { request, leave: () => caller.abort() };
};

test("at the Worker and the controller only a public model path follows its caller", () => {
  for (const path of [
    "/v1/messages",
    "/v1/responses",
    "/v1/chat/completions",
    "/typesafe/v1/models",
  ]) {
    const { request, leave } = leaving(`https://pool.example${path}`);
    const kept = followsCaller(request);
    leave();
    assert.equal(kept.signal.aborted, true, path);
  }
  for (const path of [
    nativeControlPath,
    nativeSessionPath,
    appModelPath,
    "/v0/management/config",
    "/__runtime-fleet/configure",
    "/__recovery-reset",
  ]) {
    const { request, leave } = leaving(`https://pool.example${path}`);
    const kept = followsCaller(request);
    leave();
    assert.equal(kept.signal.aborted, false, path);
  }
});

test("a fleet runtime follows its caller only for a model call to its container's model port", async () => {
  const model = {
    "X-Signalbox-Runtime-Identity": "{}",
    "X-Signalbox-Runtime-Port": "8317",
  };
  const cases: [Record<string, string>, string, boolean][] = [
    [model, "http://pool/v1/messages", true],
    [{ ...model, "X-Signalbox-Runtime-Read-Only": "1" }, "http://pool/v1/models", false],
    [{ ...model, "X-Signalbox-Runtime-Port": "8318" }, "http://pool/health", false],
    [{ ...model, "X-Signalbox-Runtime-Port": "8327" }, "http://pool/v0/management/config", false],
    [{}, "http://runtime/install", false],
    [{}, "http://runtime/start", false],
    [{}, "http://runtime/retire", false],
  ];
  for (const [headers, url, follows] of cases) {
    const { request, leave } = leaving(url, headers);
    const kept = runtimeCallerSignal(request);
    leave();
    assert.equal(kept.signal.aborted, follows, url);
    // The body goes with it either way.
    assert.equal(await kept.text(), "{}");
  }
});
