import { withAndroidManifest, type ConfigPlugin } from "expo/config-plugins";
import { addInstallPermission } from "./install-permission.ts";

/**
 * Release APKs install newer signed releases through Android's own installer. Silent updates
 * (UPDATE_PACKAGES_WITHOUT_USER_ACTION) would need a native PackageInstaller module, so the user
 * confirms each install.
 */
export const withSelfUpdate: ConfigPlugin = (config) =>
  withAndroidManifest(config, (current) => {
    addInstallPermission(current.modResults, current.android?.blockedPermissions);
    return current;
  });
