/** The longest device name this plugin reports. */
const limit = 60;

/**
 * A computer's network name as people would call it: "Alex-MacBook-Pro.local" reads "Alex MacBook
 * Pro". Nothing when no readable name is left.
 */
export function desktopDeviceName(hostname: string): string | undefined {
  const name = hostname
    .split(".")[0]!
    .replace(/[-_]+/gu, " ")
    .replace(/[^\p{L}\p{N} ']/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const capped = Array.from(name).slice(0, limit).join("").trim();
  // An address or the loopback name says nothing about the computer; Signalbox then numbers it.
  return capped.length === 0 || /^\d+$/u.test(capped) || capped.toLowerCase() === "localhost"
    ? undefined
    : capped;
}

/** A phone or tablet's kind, which is all the mobile app can tell about the device. */
export function mobileDeviceName(platform: {
  readonly isIosApp: boolean;
  readonly isAndroidApp: boolean;
  readonly isTablet: boolean;
}): string | undefined {
  if (platform.isIosApp) return platform.isTablet ? "iPad" : "iPhone";
  if (platform.isAndroidApp) return platform.isTablet ? "Android tablet" : "Android phone";
  return undefined;
}
