/**
 * Changed paths that make a PR run the live read-only baseline probe: the release barrier, its
 * phases, carried upstream code, and every root file that declares stack resources, sets their
 * properties, feeds a memoized release command or records retained-storage intent. A new or
 * changed resource must meet the full native plan with the deploy credential in its own Check,
 * not first in the release. Files that only supply Worker environment values (such as
 * framework-release.ts) or a cron constant inside runtime code (src/pool/inventory.ts) stay out.
 */
const probePaths =
  /^(?:scripts\/(?:release-barrier|release-phases)\/|patches\/|upstream\.json$|alchemy\.run\.ts$|release-declarations\.json$|brand\.ts$|scripts\/(?:environment|ensure-pool-database|pool-database-provisioning)\.ts$|src\/browser-check\.ts$|src\/telemetry\/deployment\.ts$|src\/pool\/(?:deployment|database|database-settings|worker-database|database-budget)\.ts$|\.github\/workflows\/(?:ci|deploy|release-main|release-manual)\.yml$)/;

export const probeNeeded = (changed: readonly string[]) =>
  changed.some((path) => probePaths.test(path));
