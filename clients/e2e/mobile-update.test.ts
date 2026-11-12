import assert from "node:assert/strict";
import { test } from "node:test";
import { appUpdates, checkInterval, readUpdateManifest, type UpdateManifest } from "../mobile/update.ts";
import { addInstallPermission, installPermission } from "../mobile/plugins/install-permission.ts";

const feed = "https://github.com/example/signalbox/releases/latest/download/android-update.json";
const sha = (byte: string) => byte.repeat(64);
const release = (version: string, code: number, extra: Partial<UpdateManifest> = {}) => ({
  version,
  versionCode: code,
  url: `https://github.com/example/signalbox/releases/download/signalbox-clients-${version}/Signalbox-android.apk`,
  sha256: sha("a"),
  size: 1000,
  ...extra,
});

function fixture(options: { manifest?: unknown; reachable?: boolean; bytes?: { size: number; sha256: string } } = {}) {
  let now = 1_000_000;
  let stored: string | undefined;
  let manifest: unknown = options.manifest ?? release("0.2.3", 203);
  let reachable = options.reachable ?? true;
  let bytes = options.bytes ?? { size: 1000, sha256: sha("a") };
  const files = new Map<number, { size: number; sha256: string }>();
  const events = { fetches: 0, downloads: 0, installs: 0, removed: 0 };
  const apk = (code: number) => ({
    size: () => files.get(code)?.size ?? 0,
    sha256: async () => files.get(code)?.sha256 ?? "",
    remove: () => {
      events.removed++;
      files.delete(code);
    },
    install: async () => {
      events.installs++;
    },
  });
  const ports = {
    manifestUrl: feed,
    installed: { version: "0.2.2", versionCode: 202 },
    get: async () => {
      events.fetches++;
      if (!reachable) throw new TypeError("Network request failed");
      return { ok: true, text: async () => JSON.stringify(manifest) };
    },
    files: {
      cached: (code: number) => (files.has(code) ? apk(code) : undefined),
      download: async (target: UpdateManifest, progress: (fraction: number) => void) => {
        events.downloads++;
        progress(0.5);
        files.set(target.versionCode, bytes);
        return apk(target.versionCode);
      },
      clear: (keep?: number) => {
        for (const code of files.keys()) if (code !== keep) files.delete(code);
      },
    },
    store: {
      read: async () => stored,
      write: async (value: string) => {
        stored = value;
      },
    },
    now: () => now,
  };
  const reopen = (installed = ports.installed) => appUpdates({ ...ports, installed });
  return {
    updates: appUpdates(ports),
    reopen,
    events,
    files,
    advance: (ms: number) => (now += ms),
    publishes: (next: unknown) => (manifest = next),
    setReachable: (value: boolean) => (reachable = value),
    serves: (next: { size: number; sha256: string }) => (bytes = next),
  };
}

test("a newer release downloads, verifies and waits for Install", async () => {
  const f = fixture();
  const seen: string[] = [];
  f.updates.subscribe(() => seen.push(f.updates.getSnapshot().state.kind));
  await f.updates.launch();
  assert.deepEqual(f.updates.getSnapshot().state, { kind: "ready", version: "0.2.3", versionCode: 203 });
  assert.ok(seen.includes("downloading"));
  assert.equal(f.updates.getSnapshot().firstInstall, true);
  await f.updates.install();
  assert.equal(f.events.installs, 1);
});

test("the same or an older release is up to date and downloads nothing", async () => {
  for (const [version, code] of [["0.2.2", 202], ["0.2.1", 201]] as const) {
    const f = fixture({ manifest: release(version, code) });
    await f.updates.launch();
    assert.equal(f.updates.getSnapshot().state.kind, "current");
    assert.equal(f.events.downloads, 0);
  }
});

test("manifests a release wouldn't publish are refused before anything downloads", async () => {
  const refused: Record<string, unknown> = {
    malformed: "not a manifest",
    "missing size": (({ size: _, ...rest }) => rest)(release("0.2.3", 203)),
    "fractional size": release("0.2.3", 203, { size: 10.5 }),
    "versionCode of another version": release("0.2.3", 204),
    "plain http": release("0.2.3", 203, { url: "http://github.com/example/signalbox/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk" }),
    "another host": release("0.2.3", 203, { url: "https://example.test/example/signalbox/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk" }),
    "another repository": release("0.2.3", 203, { url: "https://github.com/other/fork/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk" }),
    "another version's tag": release("0.2.3", 203, { url: "https://github.com/example/signalbox/releases/download/signalbox-clients-0.2.4/Signalbox-android.apk" }),
    "a path that climbs out": release("0.2.3", 203, { url: "https://github.com/example/signalbox/releases/download/../../../other/Signalbox-android.apk" }),
    "short hash": release("0.2.3", 203, { sha256: "abc" }),
  };
  for (const [name, manifest] of Object.entries(refused)) {
    const f = fixture({ manifest });
    await f.updates.check();
    assert.equal(f.updates.getSnapshot().state.kind, "failed", name);
    assert.equal(f.events.downloads, 0, name);
  }
});

test("a test feed's APK must sit in the feed's own folder", () => {
  const testFeed = "https://updates.example.test/run-7/android-update.json";
  const manifest = release("0.2.3", 203, { url: "https://updates.example.test/run-7/Signalbox-android.apk" });
  assert.equal(readUpdateManifest(manifest, testFeed).versionCode, 203);
  assert.throws(() =>
    readUpdateManifest({ ...manifest, url: "https://updates.example.test/run-8/Signalbox-android.apk" }, testFeed),
  );
  assert.throws(() => readUpdateManifest(manifest, "http://updates.example.test/run-7/android-update.json"));
});

test("an unreachable release fails quietly in the background and loudly on demand", async () => {
  const f = fixture({ reachable: false });
  await f.updates.launch();
  assert.equal(f.updates.getSnapshot().state.kind, "idle");
  await f.updates.check();
  const state = f.updates.getSnapshot().state;
  assert.equal(state.kind, "failed");
  f.setReachable(true);
  await f.updates.check();
  assert.equal(f.updates.getSnapshot().state.kind, "ready");
});

test("a download with the wrong size or hash is removed, never offered", async () => {
  for (const bytes of [{ size: 999, sha256: sha("a") }, { size: 1000, sha256: sha("b") }]) {
    const f = fixture({ bytes });
    await f.updates.check();
    const state = f.updates.getSnapshot().state;
    assert.equal(state.kind, "failed");
    assert.match(state.kind === "failed" ? state.message : "", /didn't match/u);
    assert.equal(f.files.size, 0);
    await f.updates.install();
    assert.equal(f.events.installs, 0);
    f.serves({ size: 1000, sha256: sha("a") });
    await f.updates.check();
    assert.equal(f.updates.getSnapshot().state.kind, "ready");
  }
});

test("foreground returns check at most every six hours; launch and on demand always check", async () => {
  const f = fixture({ manifest: release("0.2.2", 202) });
  await f.updates.launch();
  await f.updates.foreground();
  assert.equal(f.events.fetches, 1);
  f.advance(checkInterval - 1);
  await f.updates.foreground();
  assert.equal(f.events.fetches, 1);
  await f.updates.check();
  assert.equal(f.events.fetches, 2);
  f.advance(checkInterval);
  await f.updates.foreground();
  assert.equal(f.events.fetches, 3);
  await f.reopen().launch();
  assert.equal(f.events.fetches, 4);
});

test("a downloaded update survives a restart without downloading again", async () => {
  const f = fixture();
  await f.updates.launch();
  const restarted = f.reopen();
  await restarted.launch();
  assert.equal(restarted.getSnapshot().state.kind, "ready");
  assert.equal(f.events.downloads, 1);
});

test("a dismissed banner stays hidden for that version and returns for the next", async () => {
  const f = fixture();
  await f.updates.launch();
  await f.updates.dismiss();
  assert.equal(f.updates.getSnapshot().dismissed, true);
  const restarted = f.reopen();
  await restarted.launch();
  assert.equal(restarted.getSnapshot().dismissed, true);
  f.publishes(release("0.2.4", 204));
  await restarted.check();
  assert.deepEqual(restarted.getSnapshot().state, { kind: "ready", version: "0.2.4", versionCode: 204 });
  assert.equal(restarted.getSnapshot().dismissed, false);
  assert.deepEqual([...f.files.keys()], [204]);
});

test("the first-install hint disappears once an update installed from the app", async () => {
  const f = fixture();
  await f.updates.launch();
  await f.updates.install();
  const updated = f.reopen({ version: "0.2.3", versionCode: 203 });
  await updated.launch();
  assert.equal(updated.getSnapshot().firstInstall, false);
  assert.equal(updated.getSnapshot().state.kind, "current");
  assert.equal(f.files.size, 0);
});

test("the install permission is added once and refused when blocked", () => {
  const manifest = { manifest: {} as { "uses-permission"?: { $: { "android:name": string } }[] } };
  addInstallPermission(manifest);
  addInstallPermission(manifest);
  assert.deepEqual(manifest.manifest["uses-permission"], [{ $: { "android:name": installPermission } }]);
  assert.throws(() => addInstallPermission({ manifest: {} }, [installPermission]), /blockedPermissions/u);
});
