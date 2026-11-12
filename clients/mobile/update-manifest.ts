import { Schema } from "effect";
import { versionCode } from "./version-code.ts";

const apkName = "Signalbox-android.apk";
const Count = Schema.Int.check(Schema.makeFilter((value) => value > 0 && value <= 2 ** 31 - 1));
// Extra fields are ignored so a later release can add one without stranding installed apps.
export const UpdateManifest = Schema.Struct({
  version: Schema.String,
  versionCode: Count,
  url: Schema.String,
  sha256: Schema.String.check(Schema.makeFilter((value) => /^[0-9a-f]{64}$/u.test(value))),
  size: Count,
});
export type UpdateManifest = typeof UpdateManifest.Type;
const decodeManifest = Schema.decodeUnknownSync(UpdateManifest);

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
