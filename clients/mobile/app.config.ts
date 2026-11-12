import type { ExpoConfig } from "expo/config";
import { brand } from "../../brand.ts";

// Published builds carry the permanent identifiers; every other build keeps separate development
// ones, so a development install never replaces or reads the released app.
const release = process.env.SIGNALBOX_CLIENT_RELEASE === "true";
const identifier = release ? "run.signalbox.client" : "run.signalbox.client.development";

const config: ExpoConfig = {
  name: release ? brand.name : `${brand.name} Client Dev`,
  slug: "signalbox-client",
  version: "0.2.1",
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
  },
};

// Android installs a release over another only when its versionCode is higher, so it follows the
// clients version: 0.1.1 is 101 and the first release, 0.1.0, shipped Expo's default of 1.
const [major, minor, patch] = config.version!.split(".").map(Number);
if (
  ![major, minor, patch].every((part) => Number.isInteger(part)) ||
  minor! >= 100 ||
  patch! >= 100
)
  throw new Error(
    `Clients version ${config.version} must be major.minor.patch with minor and patch below 100.`,
  );
config.android!.versionCode = major! * 10000 + minor! * 100 + patch!;

export default config;
