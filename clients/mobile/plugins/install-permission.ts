/** Lets the app hand a downloaded release APK to Android's installer, which still asks the user. */
export const installPermission = "android.permission.REQUEST_INSTALL_PACKAGES";

interface Manifest {
  manifest: { "uses-permission"?: { $: { "android:name": string } }[] };
}

/** Adds the install permission once, however often prebuild applies the plugin. */
export function addInstallPermission<T extends Manifest>(manifest: T, blocked: readonly string[] = []) {
  // A blocked permission is stripped again at build time, and the installer would then refuse.
  if (blocked.includes(installPermission))
    throw new Error(
      `Self-update needs ${installPermission}, but android.blockedPermissions removes it.`,
    );
  const permissions = (manifest.manifest["uses-permission"] ??= []);
  if (!permissions.some((entry) => entry.$["android:name"] === installPermission))
    permissions.push({ $: { "android:name": installPermission } });
  return manifest;
}
