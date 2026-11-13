import type { ExpoConfig } from "expo/config";
import { brand } from "../../brand.ts";
import withNetworkRecovery from "./network-recovery.ts";
import { withSelfUpdate } from "./plugins/with-self-update.ts";
import { versionCode } from "./version-code.ts";

// Published builds carry the permanent identifiers; every other build keeps separate development
// ones, so a development install never replaces or reads the released app.
const release = process.env.SIGNALBOX_CLIENT_RELEASE === "true";
const identifier = release ? "run.signalbox.client" : "run.signalbox.client.development";

// Only release APKs update themselves: a development build would install the release beside
// itself. Each release publishes android-update.json, and releases/latest always serves the
// newest one. The release workflow passes the manifest of the repository it publishes to, or of
// a test feed; local release builds fall back to the brand's source repository.
const updateManifestUrl = release
  ? process.env.EXPO_PUBLIC_CLIENT_UPDATE_MANIFEST ||
    (brand.links.source
      ? `${brand.links.source}/releases/latest/download/android-update.json`
      : undefined)
  : undefined;
if (updateManifestUrl !== undefined && new URL(updateManifestUrl).protocol !== "https:")
  throw new Error(`The update manifest must be an https URL, not ${updateManifestUrl}.`);

const config: ExpoConfig = {
  name: release ? brand.name : `${brand.name} Client Dev`,
  slug: "signalbox-client",
  version: "0.2.3",
  scheme: release ? "signalbox-client" : "signalbox-client-dev",
  orientation: "default",
  userInterfaceStyle: "automatic",
  icon: "../../public/brand/logo.png",
  ios: {
    bundleIdentifier: identifier,
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: identifier,
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
    ],
  },
  plugins: [
    ["expo-secure-store", { faceIDPermission: false }],
    "expo-web-browser",
    "expo-dev-client",
  ],
  extra: {
    brandName: brand.name,
    serverOrigin: process.env.EXPO_PUBLIC_CLIENT_SERVER_ORIGIN ?? `https://${brand.host}`,
    updateManifestUrl,
  },
};

// The first release, 0.1.0, shipped Expo's default versionCode of 1; every later one follows its version.
config.android!.versionCode = versionCode(config.version!);

// Only builds that can update themselves ask for the install permission.
export default withNetworkRecovery(updateManifestUrl ? withSelfUpdate(config) : config);
