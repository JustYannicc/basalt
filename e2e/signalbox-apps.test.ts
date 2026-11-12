import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
  isMacBrowser,
  signalboxAppAssets,
  signalboxAppDownload,
  signalboxAppOffered,
  signalboxAppsRelease,
  signalboxAppsReleaseCheck,
  signalboxAppsReleaseNotes,
  signalboxAppsVersionLine,
  signalboxCliInstall,
} from "../.upstream/apps/hosted/web/src/contracts/signalbox-apps.ts";

const allAssets = Object.values(signalboxAppAssets);
const latest = (assets: readonly string[] = allAssets, tag = "signalbox-clients-0.2.0") => ({
  tag_name: tag,
  published_at: "2026-11-12T09:44:39Z",
  assets: assets.map((name) => ({ name })),
});

test("downloads use the version-free names of the latest release", () => {
  assert.deepEqual(allAssets, [
    "Signalbox-mac-arm64.dmg",
    "Signalbox-windows-x64-setup.exe",
    "Signalbox-linux-x86_64.AppImage",
    "Signalbox-linux-amd64.deb",
    "Signalbox-android.apk",
    "signalbox-cli.tgz",
  ]);
  assert.equal(
    signalboxAppDownload("owner/repo", signalboxAppAssets.mac),
    "https://github.com/owner/repo/releases/latest/download/Signalbox-mac-arm64.dmg",
  );
  assert.equal(
    signalboxAppsReleaseNotes("owner/repo"),
    "https://github.com/owner/repo/releases/latest",
  );
  assert.equal(
    signalboxCliInstall("owner/repo"),
    "npm install -g https://github.com/owner/repo/releases/latest/download/signalbox-cli.tgz\nsignalbox-client login",
  );
});

test("a clients release shows its version and day once", () => {
  const release = signalboxAppsRelease(200, latest());
  assert.equal(signalboxAppsVersionLine(release), "Version 0.2.0 · released 12 Nov");
  for (const asset of allAssets) assert.equal(signalboxAppOffered(release, asset), true);
  assert.equal(
    signalboxAppsVersionLine(signalboxAppsRelease(200, { tag_name: "signalbox-clients-0.2.1" })),
    "Version 0.2.1",
  );
});

test("a file the release lacks is not in this release", () => {
  const release = signalboxAppsRelease(
    200,
    latest(allAssets.filter((asset) => asset !== signalboxAppAssets.android)),
  );
  assert.equal(signalboxAppOffered(release, signalboxAppAssets.android), false);
  assert.equal(signalboxAppOffered(release, signalboxAppAssets.mac), true);
});

test("another release marked latest shows no apps version", () => {
  const release = signalboxAppsRelease(200, latest([], "signalbox-sync-0.1.0"));
  assert.equal(signalboxAppsVersionLine(release), null);
  assert.equal(signalboxAppOffered(release, signalboxAppAssets.mac), false);
});

test("without an answer from GitHub only the version line goes", () => {
  for (const [status, body] of [
    [403, null],
    [404, null],
    [500, null],
    [null, null],
    [200, "not json"],
  ] as const) {
    const release = signalboxAppsRelease(status, body);
    assert.deepEqual(release, { kind: "unconfirmed" });
    assert.equal(signalboxAppsVersionLine(release), null);
    for (const asset of allAssets) assert.equal(signalboxAppOffered(release, asset), true);
  }
});

test("Macs are recognised, iPads and other systems are not", () => {
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  assert.equal(isMacBrowser({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(isMacBrowser({ userAgentData: { platform: "Windows" }, userAgent: safari }), false);
  assert.equal(isMacBrowser({ userAgent: safari, maxTouchPoints: 0 }), true);
  assert.equal(isMacBrowser({ userAgent: safari, maxTouchPoints: 5 }), false);
  assert.equal(isMacBrowser({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), false);
  assert.equal(isMacBrowser(undefined), false);
});

test("only a read naming an apps version is remembered for the session", async () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const replies: (number | "offline" | "other")[] = [403, "offline", "other", 200];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const original = {
    fetch: globalThis.fetch,
    storage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  };
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    const reply = replies.shift()!;
    if (reply === "offline") throw new TypeError("Failed to fetch");
    if (reply === "other")
      return new Response(JSON.stringify(latest([], "signalbox-sync-0.1.0")), { status: 200 });
    return new Response(reply === 200 ? JSON.stringify(latest()) : "{}", { status: reply });
  };
  try {
    const check = () => Effect.runPromise(signalboxAppsReleaseCheck("owner/repo"));
    assert.deepEqual(await check(), { kind: "unconfirmed" });
    assert.deepEqual(await check(), { kind: "unconfirmed" });
    assert.equal(signalboxAppsVersionLine(await check()), null);
    const read = await check();
    assert.equal(signalboxAppsVersionLine(read), "Version 0.2.0 · released 12 Nov");
    assert.equal(calls.length, 4, "failed and version-less reads are asked again");
    assert.deepEqual(await check(), read);
    assert.equal(calls.length, 4, "a kept read spends no more of the GitHub quota");
  } finally {
    globalThis.fetch = original.fetch;
    if (original.storage) Object.defineProperty(globalThis, "sessionStorage", original.storage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
  // GitHub refuses credentialed or non-simple cross-origin requests.
  assert.equal(calls[0]!.url, "https://api.github.com/repos/owner/repo/releases/latest");
  assert.equal(calls[0]!.init?.credentials, "omit");
  assert.deepEqual([...new Headers(calls[0]!.init?.headers).keys()], []);
});
