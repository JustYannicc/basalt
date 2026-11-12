import assert from "node:assert/strict";
import { test } from "node:test";
import { appUpdates, checkInterval, manifestBytes } from "../mobile/update.ts";
import { readUpdateManifest, type UpdateManifest } from "../mobile/update-manifest.ts";
import { addInstallPermission, installPermission } from "../mobile/plugins/install-permission.ts";

const feed = "https://github.com/example/signalbox/releases/latest/download/android-update.json";
const sha = (byte: string) => byte.repeat(64);
const good = { size: 1000, sha256: sha("a") };
const release = (version: string, code: number, extra: Partial<UpdateManifest> = {}) => ({
  version,
  versionCode: code,
  url: `https://github.com/example/signalbox/releases/download/signalbox-clients-${version}/Signalbox-android.apk`,
  sha256: sha("a"),
  size: 1000,
  ...extra,
});
type Bytes = { size: number; sha256: string };
type Response = { status: number; body: string; length?: string };

function fixture(options: { manifest?: unknown; installed?: number } = {}) {
  let now = 1_000_000;
  let stored: string | undefined;
  let manifest: unknown = options.manifest ?? release("0.2.3", 203);
  let reply: "manifest" | "offline" | Response = "manifest";
  let bytes: Bytes = good;
  let progress = [0.5];
  let installer: () => Promise<unknown> = async () => {};
  const files = new Map<number, Bytes>();
  const events = { fetches: 0, downloads: 0, installs: 0, warnings: [] as string[] };
  const apk = (code: number) => ({
    size: () => files.get(code)?.size ?? 0,
    sha256: async () => files.get(code)?.sha256 ?? "",
    remove: () => {
      files.delete(code);
    },
    install: () => {
      events.installs++;
      return installer();
    },
  });
  const ports = {
    manifestUrl: feed,
    installed: { version: "0.2.2", versionCode: options.installed ?? 202 },
    get: async () => {
      events.fetches++;
      if (reply === "offline") throw new TypeError("Network request failed");
      const answer = reply === "manifest" ? { status: 200, body: JSON.stringify(manifest) } : reply;
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        headers: {
          get: (name: string) => (name === "content-length" ? (answer.length ?? null) : null),
        },
        text: async () => answer.body,
      };
    },
    files: {
      cached: (code: number) => (files.has(code) ? apk(code) : undefined),
      download: async (target: UpdateManifest, report: (fraction: number) => void) => {
        events.downloads++;
        for (const fraction of progress) report(fraction);
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
    warn: (message: string) => {
      events.warnings.push(message);
    },
  };
  return {
    updates: appUpdates(ports),
    reopen: (installed = ports.installed) => appUpdates({ ...ports, installed }),
    events,
    files,
    advance: (ms: number) => (now += ms),
    publishes: (next: unknown) => (manifest = next),
    answers: (next: typeof reply) => (reply = next),
    serves: (next: Bytes) => (bytes = next),
    reports: (next: number[]) => (progress = next),
    installer: (next: () => Promise<unknown>) => (installer = next),
  };
}

test("a newer release downloads, verifies and waits for Install", async () => {
  const f = fixture();
  await f.updates.launch();
  assert.deepEqual(f.updates.getSnapshot().state, {
    kind: "ready",
    version: "0.2.3",
    versionCode: 203,
  });
  assert.equal(f.updates.getSnapshot().firstInstall, true);
  await f.updates.install();
  assert.equal(f.events.installs, 1);
});

test("the same or an older release is up to date and downloads nothing", async () => {
  for (const [version, code] of [
    ["0.2.2", 202],
    ["0.2.1", 201],
  ] as const) {
    const f = fixture({ manifest: release(version, code) });
    await f.updates.launch();
    assert.equal(f.updates.getSnapshot().state.kind, "current");
    assert.equal(f.events.downloads, 0);
  }
});

test("manifests a release wouldn't publish are refused before anything downloads", async () => {
  const apkAt = (url: string) => release("0.2.3", 203, { url });
  const refused: Record<string, unknown> = {
    malformed: "not a manifest",
    "missing size": Object.fromEntries(
      Object.entries(release("0.2.3", 203)).filter(([key]) => key !== "size"),
    ),
    "fractional size": release("0.2.3", 203, { size: 10.5 }),
    "versionCode of another version": release("0.2.3", 204),
    "plain http": apkAt(
      "http://github.com/example/signalbox/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk",
    ),
    "another host": apkAt(
      "https://example.test/example/signalbox/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk",
    ),
    "another repository": apkAt(
      "https://github.com/other/fork/releases/download/signalbox-clients-0.2.3/Signalbox-android.apk",
    ),
    "another version's tag": apkAt(
      "https://github.com/example/signalbox/releases/download/signalbox-clients-0.2.4/Signalbox-android.apk",
    ),
    "a path that climbs out": apkAt(
      "https://github.com/example/signalbox/releases/download/../../../other/Signalbox-android.apk",
    ),
    "short hash": release("0.2.3", 203, { sha256: "abc" }),
  };
  for (const [name, manifest] of Object.entries(refused)) {
    const f = fixture({ manifest });
    await f.updates.check();
    assert.match(f.updates.getSnapshot().error ?? "", /No usable update/u, name);
    assert.equal(f.events.downloads, 0, name);
    assert.deepEqual(f.events.warnings, ["Signalbox update check failed: manifest was refused."]);
  }
});

test("a test feed's APK must sit in the feed's own folder", () => {
  const testFeed = "https://updates.example.test/run-7/android-update.json";
  const manifest = release("0.2.3", 203, {
    url: "https://updates.example.test/run-7/Signalbox-android.apk",
  });
  assert.equal(readUpdateManifest(manifest, testFeed).versionCode, 203);
  assert.throws(() =>
    readUpdateManifest(
      { ...manifest, url: "https://updates.example.test/run-8/Signalbox-android.apk" },
      testFeed,
    ),
  );
  assert.throws(() =>
    readUpdateManifest(manifest, "http://updates.example.test/run-7/android-update.json"),
  );
});

test("an unreachable server fails quietly in the background and says why on demand", async () => {
  const f = fixture();
  f.answers("offline");
  await f.updates.launch();
  assert.equal(f.updates.getSnapshot().state.kind, "idle");
  assert.equal(f.updates.getSnapshot().error, undefined);
  await f.updates.check();
  assert.match(f.updates.getSnapshot().error ?? "", /Couldn't reach/u);
  f.answers("manifest");
  await f.updates.check();
  assert.equal(f.updates.getSnapshot().state.kind, "ready");
  assert.equal(f.updates.getSnapshot().error, undefined);
});

test("a missing or oversized manifest says no update is published, not that you're offline", async () => {
  const cases: [Response, string][] = [
    [{ status: 404, body: "Not Found" }, "manifest answered HTTP 404"],
    [
      { status: 200, body: "{}", length: String(manifestBytes + 1) },
      "manifest is larger than 64 KiB",
    ],
    [{ status: 200, body: "é".repeat(manifestBytes / 2 + 1) }, "manifest is larger than 64 KiB"],
  ];
  for (const [reply, detail] of cases) {
    const f = fixture();
    f.answers(reply);
    await f.updates.check();
    assert.match(f.updates.getSnapshot().error ?? "", /No usable update/u, detail);
    assert.deepEqual(f.events.warnings, [`Signalbox update check failed: ${detail}.`]);
  }
});

test("a download with the wrong size or hash is removed, never offered", async () => {
  for (const bytes of [
    { size: 999, sha256: sha("a") },
    { size: 1000, sha256: sha("b") },
  ]) {
    const f = fixture();
    f.serves(bytes);
    await f.updates.check();
    assert.match(f.updates.getSnapshot().error ?? "", /didn't match/u);
    assert.equal(f.files.size, 0);
    await f.updates.install();
    assert.equal(f.events.installs, 0);
    f.serves(good);
    await f.updates.check();
    assert.equal(f.updates.getSnapshot().state.kind, "ready");
  }
});

test("foreground returns check at most every six hours after a finished check", async () => {
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

test("a failed background check doesn't postpone the next return's check", async () => {
  const f = fixture({ manifest: release("0.2.2", 202) });
  f.answers("offline");
  await f.updates.launch();
  await f.updates.foreground();
  assert.equal(f.events.fetches, 2);
  f.answers("manifest");
  await f.updates.foreground();
  await f.updates.foreground();
  assert.equal(f.events.fetches, 3);
});

test("a downloaded update shows after a restart, offline and while a check runs", async () => {
  const f = fixture();
  await f.updates.launch();
  f.answers("offline");
  const restarted = f.reopen();
  const seen: string[] = [];
  restarted.subscribe(() => seen.push(restarted.getSnapshot().state.kind));
  await restarted.launch();
  assert.equal(restarted.getSnapshot().state.kind, "ready");
  assert.equal(restarted.getSnapshot().error, undefined);
  assert.ok(
    seen.every((kind) => kind === "ready"),
    seen.join(),
  );
  assert.equal(f.events.downloads, 1);
});

test("a saved update whose file changed or vanished isn't offered after a restart", async () => {
  const f = fixture();
  await f.updates.launch();
  f.files.set(203, { size: 1000, sha256: sha("c") });
  f.answers("offline");
  const restarted = f.reopen();
  await restarted.launch();
  assert.equal(restarted.getSnapshot().state.kind, "idle");
});

test("an offered update whose file was evicted stops being offered if it can't download again", async () => {
  const f = fixture();
  await f.updates.launch();
  f.files.delete(203);
  f.serves({ size: 1, sha256: sha("b") });
  await f.updates.launch();
  assert.equal(f.updates.getSnapshot().state.kind, "idle");
  await f.updates.install();
  assert.equal(f.events.installs, 0);
});

test("a cached APK for another version is never offered, and is removed once this one verifies", async () => {
  for (const other of [201, 204]) {
    const f = fixture();
    f.files.set(other, good);
    await f.updates.launch();
    assert.deepEqual(f.updates.getSnapshot().state, {
      kind: "ready",
      version: "0.2.3",
      versionCode: 203,
    });
    assert.equal(f.events.downloads, 1);
    assert.deepEqual([...f.files.keys()], [203]);
  }
});

test("download progress publishes only when the whole percent changes", async () => {
  const f = fixture();
  f.reports([0.001, 0.004, 0.009, 0.01, 0.012, 0.5, 0.501, 0.505, 1]);
  const seen: number[] = [];
  f.updates.subscribe(() => {
    const { state } = f.updates.getSnapshot();
    if (state.kind === "downloading") seen.push(state.progress);
  });
  await f.updates.launch();
  assert.deepEqual(seen, [0, 1, 50, 100]);
});

test("a second tap while the installer is open starts nothing and reports nothing", async () => {
  const f = fixture();
  await f.updates.launch();
  let close = () => {};
  f.installer(() => new Promise<void>((resolve) => (close = resolve)));
  const first = f.updates.install();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.updates.getSnapshot().installing, true);
  await f.updates.install();
  assert.equal(f.events.installs, 1);
  assert.equal(f.updates.getSnapshot().error, undefined);
  close();
  await first;
  assert.equal(f.updates.getSnapshot().installing, false);
});

test("an installer that won't open says so, keeps the update, and Retry offers it again", async () => {
  const f = fixture();
  await f.updates.launch();
  f.installer(async () => {
    throw new Error("No activity");
  });
  await f.updates.install();
  assert.match(f.updates.getSnapshot().error ?? "", /couldn't open the installer/u);
  assert.equal(f.updates.getSnapshot().state.kind, "ready");
  await f.updates.check();
  assert.equal(f.updates.getSnapshot().error, undefined);
  assert.equal(f.updates.getSnapshot().state.kind, "ready");
  assert.equal(f.events.downloads, 1);
  f.installer(async () => {});
  await f.updates.install();
  assert.equal(f.events.installs, 2);
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
  assert.deepEqual(restarted.getSnapshot().state, {
    kind: "ready",
    version: "0.2.4",
    versionCode: 204,
  });
  assert.equal(restarted.getSnapshot().dismissed, false);
  assert.deepEqual([...f.files.keys()], [204]);
});

test("the first-install hint goes only after an install the app itself launched", async () => {
  const launched = fixture();
  await launched.updates.launch();
  await launched.updates.install();
  const updated = launched.reopen({ version: "0.2.3", versionCode: 203 });
  await updated.launch();
  assert.equal(updated.getSnapshot().firstInstall, false);
  assert.equal(updated.getSnapshot().state.kind, "current");
  assert.equal(launched.files.size, 0);

  const skipped = fixture();
  await skipped.updates.launch();
  await skipped.updates.install();
  const later = skipped.reopen({ version: "0.2.4", versionCode: 204 });
  await later.launch();
  assert.equal(later.getSnapshot().firstInstall, true);

  const failedLaunch = fixture();
  await failedLaunch.updates.launch();
  failedLaunch.installer(async () => {
    throw new Error("No activity");
  });
  await failedLaunch.updates.install();
  const byHand = failedLaunch.reopen({ version: "0.2.3", versionCode: 203 });
  await byHand.launch();
  assert.equal(byHand.getSnapshot().firstInstall, true);
});

test("the install permission is added once and refused when blocked", () => {
  const manifest = {
    manifest: {} as { "uses-permission"?: { $: { "android:name": string } }[] },
  };
  addInstallPermission(manifest);
  addInstallPermission(manifest);
  assert.deepEqual(manifest.manifest["uses-permission"], [
    { $: { "android:name": installPermission } },
  ]);
  assert.throws(
    () => addInstallPermission({ manifest: {} }, [installPermission]),
    /blockedPermissions/u,
  );
});
