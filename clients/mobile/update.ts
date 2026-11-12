import { Schema } from "effect";
import { versionCode } from "./version-code.ts";

/** A foreground return checks again only after this long; launch and Check for updates always do. */
export const checkInterval = 6 * 60 * 60 * 1000;
const manifestTimeout = 20_000;
// A download that makes no progress for this long is abandoned and retried on a later check.
const downloadStall = 60_000;
const manifestBytes = 64 * 1024;
const apkName = "Signalbox-android.apk";

const Count = Schema.Int.check(Schema.makeFilter((value) => value > 0 && value <= 2 ** 31 - 1));
// Extra fields are ignored so a later release can add one without stranding installed apps.
const Manifest = Schema.Struct({
  version: Schema.String,
  versionCode: Count,
  url: Schema.String,
  sha256: Schema.String.check(Schema.makeFilter((value) => /^[0-9a-f]{64}$/u.test(value))),
  size: Count,
});
export type UpdateManifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownSync(Manifest);

/**
 * The APK must come from where its manifest was published: the same release repository, under
 * the tag of its own version, or, for a test feed, the manifest's own folder.
 */
function expectedApkPath(feed: URL, version: string) {
  const latest = feed.pathname.indexOf("/releases/latest/download/");
  return latest >= 0
    ? `${feed.pathname.slice(0, latest)}/releases/download/signalbox-clients-${version}/${apkName}`
    : `${feed.pathname.slice(0, feed.pathname.lastIndexOf("/") + 1)}${apkName}`;
}

/** Reads android-update.json, refusing anything a release of this app wouldn't publish. */
export function readUpdateManifest(raw: unknown, manifestUrl: string): UpdateManifest {
  const manifest = decodeManifest(raw);
  if (versionCode(manifest.version) !== manifest.versionCode)
    throw new Error(`Manifest versionCode ${manifest.versionCode} isn't ${manifest.version}'s.`);
  const feed = new URL(manifestUrl);
  const apk = new URL(manifest.url);
  if (
    feed.protocol !== "https:" ||
    apk.protocol !== "https:" ||
    apk.username !== "" ||
    apk.password !== "" ||
    apk.host !== feed.host ||
    apk.search !== "" ||
    apk.hash !== "" ||
    apk.pathname !== expectedApkPath(feed, manifest.version)
  )
    throw new Error(`Manifest APK ${manifest.url} isn't next to ${manifestUrl}.`);
  return manifest;
}

/** Only a strictly higher versionCode is an update; Android refuses to install a lower one. */
export const isNewer = (manifest: UpdateManifest, installed: number) =>
  manifest.versionCode > installed;

export type CheckReason = "launch" | "foreground" | "manual";
/** Launch and manual checks always run; a foreground return runs at most every six hours. */
export const checkDue = (reason: CheckReason, lastCheck: number | undefined, now: number) =>
  reason !== "foreground" || lastCheck === undefined || now - lastCheck >= checkInterval;

export interface DownloadedApk {
  size(): number;
  sha256(): Promise<string>;
  remove(): void;
  /** Hands the file to Android's installer, which asks the user to confirm. */
  install(): Promise<unknown>;
}
export interface UpdatePorts {
  manifestUrl: string;
  installed: { version: string; versionCode: number };
  get(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; text(): Promise<string> }>;
  files: {
    cached(versionCode: number): DownloadedApk | undefined;
    download(
      manifest: UpdateManifest,
      progress: (fraction: number) => void,
      signal: AbortSignal,
    ): Promise<DownloadedApk>;
    /** Removes every downloaded APK except the one for `keep`, including partial downloads. */
    clear(keep?: number): void;
  };
  store: { read(): Promise<string | undefined>; write(value: string): Promise<void> };
  now(): number;
}
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "downloading"; version: string; progress: number }
  | { kind: "ready"; version: string; versionCode: number }
  | { kind: "failed"; message: string };
export interface UpdateSnapshot {
  installed: { version: string; versionCode: number };
  state: UpdateState;
  /** The home banner stays hidden for this ready version; the next version shows it again. */
  dismissed: boolean;
  /** No update has installed from inside the app yet, so Android will ask to allow the source. */
  firstInstall: boolean;
}

const Saved = Schema.Struct({
  lastCheck: Schema.optionalKey(Schema.Number),
  dismissed: Schema.optionalKey(Schema.Number),
  installing: Schema.optionalKey(Schema.Number),
  installedInApp: Schema.optionalKey(Schema.Boolean),
});
type Saved = { -readonly [K in keyof typeof Saved.Type]: (typeof Saved.Type)[K] };
const decodeSaved = Schema.decodeUnknownSync(Saved);

const checkFailed = "Couldn't check for updates. Check your connection and try again.";
const mismatch = "The download didn't match its release, so it was removed. Try again.";
const installFailed = "Android couldn't open the installer. Try again.";

/** Checks, downloads and verifies release APKs; the UI only reads snapshots and calls actions. */
export function appUpdates(ports: UpdatePorts) {
  let saved: Saved = {};
  let state: UpdateState = { kind: "idle" };
  let ready: DownloadedApk | undefined;
  let running: Promise<void> | undefined;
  let visible = false;
  let loaded: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  let snapshot = view();
  function view(): UpdateSnapshot {
    return {
      installed: ports.installed,
      state,
      dismissed: state.kind === "ready" && saved.dismissed === state.versionCode,
      firstInstall: !saved.installedInApp,
    };
  }
  const publish = (next: UpdateState = state) => {
    state = next;
    snapshot = view();
    for (const listener of listeners) listener();
  };
  // Persisting is best effort: losing it only repeats a check or shows a banner again.
  const persist = async () => {
    try {
      await ports.store.write(JSON.stringify(saved));
    } catch {}
  };
  // Cleanup is best effort too: a leftover file in the cache directory never blocks an update.
  const tidy = (keep?: number) => {
    try {
      ports.files.clear(keep);
    } catch {}
  };
  const load = () =>
    (loaded ??= (async () => {
      try {
        const raw = await ports.store.read();
        if (raw) saved = { ...decodeSaved(JSON.parse(raw)) };
      } catch {}
      if (saved.installing !== undefined && ports.installed.versionCode >= saved.installing) {
        saved.installedInApp = true;
        delete saved.installing;
        await persist();
      }
      publish();
    })());

  const verified = async (apk: DownloadedApk, manifest: UpdateManifest) => {
    try {
      return apk.size() === manifest.size && (await apk.sha256()) === manifest.sha256;
    } catch {
      return false;
    }
  };

  const fetchManifest = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), manifestTimeout);
    try {
      const response = await ports.get(ports.manifestUrl, { signal: controller.signal });
      if (!response.ok) throw new Error("The update manifest wasn't available.");
      const text = await response.text();
      if (text.length > manifestBytes) throw new Error("The update manifest is too large.");
      return readUpdateManifest(JSON.parse(text), ports.manifestUrl);
    } finally {
      clearTimeout(timer);
    }
  };

  const download = async (manifest: UpdateManifest) => {
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), downloadStall);
    publish({ kind: "downloading", version: manifest.version, progress: 0 });
    try {
      return await ports.files.download(
        manifest,
        (fraction) => {
          clearTimeout(stall);
          stall = setTimeout(() => controller.abort(), downloadStall);
          publish({ kind: "downloading", version: manifest.version, progress: fraction });
        },
        controller.signal,
      );
    } finally {
      clearTimeout(stall);
    }
  };

  const run = async () => {
    const before = state;
    publish({ kind: "checking" });
    let message = checkFailed;
    try {
      saved.lastCheck = ports.now();
      await persist();
      const manifest = await fetchManifest();
      if (!isNewer(manifest, ports.installed.versionCode)) {
        ready = undefined;
        tidy();
        publish({ kind: "current" });
        return;
      }
      const cached = ports.files.cached(manifest.versionCode);
      let apk = cached && (await verified(cached, manifest)) ? cached : undefined;
      if (!apk) {
        const fresh = await download(manifest);
        if (!(await verified(fresh, manifest))) {
          message = mismatch;
          fresh.remove();
          throw new Error(message);
        }
        apk = fresh;
      }
      tidy(manifest.versionCode);
      ready = apk;
      publish({ kind: "ready", version: manifest.version, versionCode: manifest.versionCode });
    } catch {
      // Background checks fail quietly and try again on a later launch or return.
      // A ready APK stays ready: only a successful check removes older downloads.
      publish(visible ? { kind: "failed", message } : before);
    }
  };

  const check = async (reason: CheckReason) => {
    await load();
    if (reason === "manual") visible = true;
    if (running) return running;
    if (!checkDue(reason, saved.lastCheck, ports.now())) return;
    running = run().finally(() => {
      running = undefined;
      visible = false;
    });
    return running;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    launch: () => check("launch"),
    foreground: () => check("foreground"),
    check: () => check("manual"),
    dismiss: async () => {
      if (state.kind !== "ready") return;
      saved.dismissed = state.versionCode;
      publish();
      await persist();
    },
    install: async () => {
      if (state.kind !== "ready" || !ready) return;
      saved.installing = state.versionCode;
      await persist();
      try {
        await ready.install();
      } catch {
        publish({ kind: "failed", message: installFailed });
        // The verified file stays; Retry finds it again without downloading.
      }
    },
  };
}
export type AppUpdates = ReturnType<typeof appUpdates>;
