// Every date and time the pool shows, in the host's one shape: day-month-year on a 24-hour clock,
// such as "21.11.2026 14:30". The formatter is the host's shared module, which the bundler
// packages with this app, so the pool and Accounts never disagree on a format.
import { formatMoment } from "./observation-text.ts";

export { formatMoment };

/** The reader's own locale and time zone, as the host's Accounts rows use them. */
export const readerFormat = (() => {
  const options = new Intl.DateTimeFormat().resolvedOptions();
  return { locale: options.locale, timeZone: options.timeZone };
})();

/** Pool records count in UTC days and hours, so their moments say UTC instead of shifting. */
export const utc = { locale: "en", timeZone: "UTC" };

/** A UTC record time with its zone, such as "21.11.2026 14:30 UTC". */
export const utcMoment = (value: string | number, options: Intl.DateTimeFormatOptions = {}) =>
  formatMoment(value, utc, { ...options, timeZoneName: "short" });
