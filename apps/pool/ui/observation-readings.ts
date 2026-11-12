// The host's Details table, so the pool renders the same rows Accounts does. This path is for
// local checks: the pool app bundler copies the file into the authored UI and points this module
// at the copy, so no host UI package is needed at runtime.
export { ObservationReadingsTable } from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-readings-view.tsx";
