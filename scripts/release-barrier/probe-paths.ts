/**
 * Changed paths that make a PR run the live read-only baseline probe: the release barrier, its
 * phases, carried upstream code, and every root file that declares stack resources, sets their
 * properties, feeds a memoized release command or records retained-storage intent. A new or
 * changed resource must meet the full native plan with the deploy credential in its own Check,
 * not first in the release. The post-deploy image verifier runs against production in the same
 * Check, so a change to it is proven there before a release relies on it. Files that only supply Worker environment values (such as
 * framework-release.ts) or a cron constant inside runtime code (src/pool/inventory.ts) stay out.
 */
const probePaths =
  /^(?:scripts\/(?:release-barrier|release-phases)\/|patches\/|upstream\.json$|alchemy\.run\.ts$|release-declarations\.json$|brand\.ts$|scripts\/(?:environment|ensure-pool-database|pool-database-provisioning)\.ts$|scripts\/deploy-safety\/(?:pool-image(?:-fleet)?|capture-pool-image|assert-pool-image|http|cloudflare|contracts)\.ts$|scripts\/pool-readiness\.ts$|scripts\/ci\/probe-candidate\.ts$|src\/browser-check\.ts$|src\/telemetry\/deployment\.ts$|src\/pool\/(?:deployment|database|database-settings|worker-database|database-budget)\.ts$|\.github\/workflows\/(?:ci|deploy|release-main|release-manual)\.yml$)/;

export const probeNeeded = (changed: readonly string[]) =>
  changed.some((path) => probePaths.test(path));

/**
 * Changed paths that make a PR run the read-only release preflight: anything the release path
 * executes, the workflows that start it, and the pool runtime protocol its reads speak.
 */
const preflightPaths =
  /^(?:scripts\/release-[a-z-]+\/|scripts\/deploy(?:-[a-z-]+)?(?:\/|\.ts$)|scripts\/pool-operations[^/]*$|scripts\/database-budget-readiness\.ts$|src\/pool\/(?:runtime[^/]*(?:\/|$)|deployment-readiness\.ts$|token\.ts$|worker\.ts$|recovery-approval\.ts$|image-release-plan\.ts$)|\.github\/workflows\/(?:ci|deploy|release-[a-z-]+)\.yml$)/;

export const releasePreflightNeeded = (changed: readonly string[]) =>
  changed.some((path) => preflightPaths.test(path));
