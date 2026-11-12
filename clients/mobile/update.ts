import { Schema } from "effect";
import { UpdateManifest, isNewer, readUpdateManifest } from "./update-manifest.ts";

/** A foreground return checks again only after this long; launch and Check for updates always do. */
export const checkInterval = 6 * 60 * 60 * 1000;
export const manifestBytes = 64 * 1024;
const manifestTimeout = 20_000;
// A download that makes no progress for this long is abandoned and retried on a later check.
const downloadStall = 60_000;

export type CheckReason = "launch" | "foreground" | "manual";
/** Launch and manual checks always run; a foreground return runs at most every six hours. */
export const checkDue = (reason: CheckReason, lastCheck: number | undefined, now: number) =>
  reason !== "foreground" || lastCheck === undefined || now - lastCheck >= checkInterval;

export interface DownloadedApk {
  size(): number;
  sha256(): Promise<string>;
  remove(): void;
  /** Hands the file to Android's installer; settles when the installer screen closes. */
  install(): Promise<unknown>;
}
export interface UpdatePorts {
  manifestUrl: string;
  installed: { version: string; versionCode: number };
  get(
    url: string,
    init: { signal: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
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
  /** Receives fixed diagnostic lines, never URLs or response bodies. */
  warn(message: string): void;
}
export type UpdateState =
  | { kind: "idle" }
  | { kind: "current" }
  /** `progress` is a whole percent; it changes at most a hundred times per download. */
  | { kind: "downloading"; version: string; progress: number }
  | { kind: "ready"; version: string; versionCode: number };
export interface UpdateSnapshot {
  installed: { version: string; versionCode: number };
  state: UpdateState;
  checking: boolean;
  /** Android's installer is open for the ready version. */
  installing: boolean;
  /** Only a check or install the user started reports a failure. */
  error?: string;
  /** The home banner stays hidden for this ready version; the next version shows it again. */
  dismissed: boolean;
  /** No update this app handed to Android's installer has installed yet. */
  firstInstall: boolean;
}

const Saved = Schema.Struct({
  lastCheck: Schema.optionalKey(Schema.Number),
  dismissed: Schema.optionalKey(Schema.Number),
  /** The versionCode the app last handed to Android's installer. */
  launched: Schema.optionalKey(Schema.Number),
  installedInApp: Schema.optionalKey(Schema.Boolean),
  /** The last verified manifest, so a downloaded update shows offline and after a restart. */
  manifest: Schema.optionalKey(UpdateManifest),
});
type Saved = { -readonly [K in keyof typeof Saved.Type]: (typeof Saved.Type)[K] };
const decodeSaved = Schema.decodeUnknownSync(Saved);

const failures = {
  network: "Couldn't reach the update server. Check your connection and try again.",
  unpublished: "No usable update is published right now. Try again later.",
  mismatch: "The download didn't match its release, so it was removed. Try again.",
  install: "Android couldn't open the installer. Try again.",
};
class Failure extends Error {
  readonly kind: keyof typeof failures;
  constructor(kind: keyof typeof failures, detail: string) {
    super(detail);
    this.kind = kind;
  }
}

/** Checks, downloads and verifies release APKs; the UI only reads snapshots and calls actions. */
export function appUpdates(ports: UpdatePorts) {
  let saved: Saved = {};
  let state: UpdateState = { kind: "idle" };
  let ready: { apk: DownloadedApk; manifest: UpdateManifest } | undefined;
  let checking = false;
  let installing = false;
  let error: string | undefined;
  let running: Promise<void> | undefined;
  let visible = false;
  let loaded: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  let snapshot = view();
  function view(): UpdateSnapshot {
    return {
      installed: ports.installed,
      state,
      checking,
      installing,
      ...(error ? { error } : {}),
      dismissed: state.kind === "ready" && saved.dismissed === state.versionCode,
      firstInstall: !saved.installedInApp,
    };
  }
  const publish = (next: UpdateState = state) => {
    state = next;
    snapshot = view();
    for (const listener of listeners) listener();
  };
  const readyState = (current: NonNullable<typeof ready>): UpdateState => ({
    kind: "ready",
    version: current.manifest.version,
    versionCode: current.manifest.versionCode,
  });
  // Persisting is best effort: losing it only repeats a check or shows a banner again.
  const persist = async () => {
    try {
      await ports.store.write(JSON.stringify(saved));
    } catch {}
  };
  // Cleanup is best effort too: a leftover file in the cache directory never blocks an update.
  const tidy = (keep?: number) => {
    // Android's installer may still be reading an offered file through its content URI; the next
    // check tidies once the install has finished.
    if (installing) return;
    try {
      ports.files.clear(keep);
    } catch {}
  };
  const verified = async (apk: DownloadedApk, manifest: UpdateManifest) => {
    try {
      return apk.size() === manifest.size && (await apk.sha256()) === manifest.sha256;
    } catch {
      return false;
    }
  };
  const cachedApk = async (manifest: UpdateManifest) => {
    const apk = ports.files.cached(manifest.versionCode);
    return apk && (await verified(apk, manifest)) ? apk : undefined;
  };

  const load = () =>
    (loaded ??= (async () => {
      try {
        const raw = await ports.store.read();
        if (raw) saved = { ...decodeSaved(JSON.parse(raw)) };
      } catch {}
      const installed = ports.installed.versionCode;
      if (saved.launched !== undefined && installed >= saved.launched) {
        // Only the exact version this app handed to the installer proves the source is allowed.
        if (installed === saved.launched) saved.installedInApp = true;
        delete saved.launched;
      }
      // Android may restart the app after "Install unknown apps" is turned on, often offline.
      if (saved.manifest) {
        let manifest: UpdateManifest | undefined;
        try {
          manifest = readUpdateManifest(saved.manifest, ports.manifestUrl);
        } catch {}
        const apk = manifest && isNewer(manifest, installed) && (await cachedApk(manifest));
        if (manifest && apk) ready = { apk, manifest };
        else delete saved.manifest;
      }
      await persist();
      publish(ready ? readyState(ready) : state);
    })());

  const fetchManifest = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), manifestTimeout);
    try {
      const response = await ports
        .get(ports.manifestUrl, { signal: controller.signal })
        .catch(() => Promise.reject(new Failure("network", "manifest request failed")));
      if (!response.ok)
        throw new Failure("unpublished", `manifest answered HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > manifestBytes)
        throw new Failure("unpublished", "manifest is larger than 64 KiB");
      const text = await response
        .text()
        .catch(() => Promise.reject(new Failure("network", "manifest body was interrupted")));
      if (new TextEncoder().encode(text).length > manifestBytes)
        throw new Failure("unpublished", "manifest is larger than 64 KiB");
      try {
        return readUpdateManifest(JSON.parse(text), ports.manifestUrl);
      } catch {
        throw new Failure("unpublished", "manifest was refused");
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const download = async (manifest: UpdateManifest) => {
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), downloadStall);
    let shown = 0;
    // An older verified update stays offered until this one is verified.
    if (!ready) publish({ kind: "downloading", version: manifest.version, progress: 0 });
    try {
      const apk = await ports.files
        .download(
          manifest,
          (fraction) => {
            clearTimeout(stall);
            stall = setTimeout(() => controller.abort(), downloadStall);
            // Native progress arrives every few milliseconds; the screen only needs whole percents.
            const percent = Math.min(100, Math.floor(fraction * 100));
            if (ready || percent === shown) return;
            shown = percent;
            publish({ kind: "downloading", version: manifest.version, progress: percent });
          },
          controller.signal,
        )
        .catch(() => Promise.reject(new Failure("network", "APK download failed")));
      if (!(await verified(apk, manifest))) {
        try {
          apk.remove();
        } catch {}
        throw new Failure("mismatch", "APK size or SHA-256 differs from the manifest");
      }
      return apk;
    } finally {
      clearTimeout(stall);
    }
  };

  const run = async () => {
    const before = state;
    checking = true;
    error = undefined;
    publish();
    try {
      const manifest = await fetchManifest();
      if (!isNewer(manifest, ports.installed.versionCode)) {
        ready = undefined;
        delete saved.manifest;
        tidy();
        state = { kind: "current" };
      } else {
        let apk = await cachedApk(manifest);
        if (!apk) {
          // The offered file is gone or no longer this release's (the cache can be evicted).
          if (ready && ready.manifest.versionCode >= manifest.versionCode) ready = undefined;
          apk = await download(manifest);
        }
        ready = { apk, manifest };
        saved.manifest = manifest;
        tidy(manifest.versionCode);
        state = readyState(ready);
      }
      // Only a finished check postpones the next one; a failed one retries on the next return.
      saved.lastCheck = ports.now();
      await persist();
    } catch (cause) {
      const failure = cause instanceof Failure ? cause : new Failure("network", "check failed");
      ports.warn(`Signalbox update check failed: ${failure.message}.`);
      if (visible) error = failures[failure.kind];
      // A verified update stays offered whatever happened to this check; one whose file was
      // gone stops being offered.
      state = ready ? readyState(ready) : before.kind === "ready" ? { kind: "idle" } : before;
    } finally {
      checking = false;
      publish();
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
      // A second tap while the installer is open would otherwise start a second activity.
      if (!ready || installing || state.kind !== "ready") return;
      const current = ready;
      installing = true;
      error = undefined;
      saved.launched = current.manifest.versionCode;
      publish();
      await persist();
      try {
        await current.apk.install();
      } catch {
        delete saved.launched;
        await persist();
        ports.warn("Signalbox update install failed: the installer didn't open.");
        error = failures.install;
      } finally {
        installing = false;
        publish();
      }
    },
  };
}
export type AppUpdates = ReturnType<typeof appUpdates>;
