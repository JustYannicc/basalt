import * as Application from "expo-application";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { appUpdates, type DownloadedApk } from "./update.ts";

const manifestUrl = Constants.expoConfig?.extra?.updateManifestUrl;
const version = Application.nativeApplicationVersion;
const code = Number(Application.nativeBuildVersion);
const folder = new Directory(Paths.cache, "updates");
const name = (versionCode: number) => `Signalbox-android-${versionCode}.apk`;
// Intent.FLAG_GRANT_READ_URI_PERMISSION lets the installer read the app's private file.
const grantRead = 1;

function apk(file: File): DownloadedApk {
  return {
    size: () => file.size,
    // Hashes natively in 64 KB chunks, so a 25 MB APK never crosses into JavaScript.
    sha256: () => file.digest("SHA-256"),
    remove: () => {
      if (file.exists) file.delete();
    },
    install: () =>
      IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: file.contentUri,
        flags: grantRead,
        type: "application/vnd.android.package-archive",
      }),
  };
}

/** Present only in Android release builds, the only ones published with an update manifest. */
export const updates =
  Platform.OS === "android" &&
  typeof manifestUrl === "string" &&
  version !== null &&
  Number.isSafeInteger(code) &&
  code > 0
    ? appUpdates({
        manifestUrl,
        installed: { version, versionCode: code },
        get: (url, init) => globalThis.fetch(url, init),
        files: {
          cached: (versionCode) => {
            const file = new File(folder, name(versionCode));
            return file.exists ? apk(file) : undefined;
          },
          download: async (manifest, progress, signal) => {
            folder.create({ idempotent: true, intermediates: true });
            const file = await File.downloadFileAsync(
              manifest.url,
              new File(folder, name(manifest.versionCode)),
              {
                idempotent: true,
                signal,
                onProgress: ({ bytesWritten }) =>
                  progress(Math.min(1, bytesWritten / manifest.size)),
              },
            );
            return apk(file);
          },
          clear: (keep) => {
            if (!folder.exists) return;
            for (const entry of folder.list())
              if (!(entry instanceof File && keep !== undefined && entry.name === name(keep)))
                entry.delete();
          },
        },
        store: (() => {
          const file = new File(Paths.document, "signalbox-update.json");
          return {
            read: async () => (file.exists ? await file.text() : undefined),
            write: (value) => file.write(value),
          };
        })(),
        now: () => Date.now(),
        warn: (message) => console.warn(message),
      })
    : undefined;
