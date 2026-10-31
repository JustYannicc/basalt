import type { ExpoConfig } from "expo/config";
import { brand } from "../../brand.ts";

const config: ExpoConfig = {
  name: `${brand.name} Client Dev`,
  slug: "signalbox-client",
  version: "0.1.0",
  scheme: "signalbox-client-dev",
  orientation: "default",
  userInterfaceStyle: "automatic",
  icon: "../../public/brand/logo.png",
  ios: {
    bundleIdentifier: "run.signalbox.client.development",
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: "run.signalbox.client.development",
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

export default config;
