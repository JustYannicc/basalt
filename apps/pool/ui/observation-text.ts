// The host's pure Details text, so the pool says exactly what Accounts says. This path is for
// local checks: the pool app bundler copies the file into the authored UI and points this module
// at the copy, so no host UI package is needed at runtime. Kept apart from the table so unit tests
// load no JSX.
export {
  orderedWindows,
  resetCountText,
  resetEffect,
  windowView,
  type DisplayFormat,
  type ReadingBalance,
  type ReadingObservation,
  type ReadingWindow,
} from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-text.ts";
