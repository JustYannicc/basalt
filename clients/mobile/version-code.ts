/**
 * Android installs a release over another only when its versionCode is higher, so it follows the
 * clients version: 0.2.1 is 201. The release workflow computes the same number for the update
 * manifest, and the app refuses a manifest whose number doesn't match its version.
 */
export function versionCode(version: string) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)?.slice(1).map(Number);
  const [major, minor, patch] = parts ?? [];
  if (major === undefined || minor === undefined || patch === undefined || minor >= 100 || patch >= 100)
    throw new Error(
      `Clients version ${version} must be major.minor.patch with minor and patch below 100.`,
    );
  return major * 10000 + minor * 100 + patch;
}
