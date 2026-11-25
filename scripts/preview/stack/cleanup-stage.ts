/** Alchemy's `state` commands take no --stage and open the stack under this placeholder stage. */
export const stateCommandStage = "placeholder";
const readOnlyStateCommands = new Set(["list", "ls", "read", "cat"]);

/**
 * The stage a cleanup run acts for. A state command opens the placeholder stage, and reads the
 * store for the configured stage only when it is a read: `state delete` and `state unsafe nuke`
 * reach any path in the shared store, production's included, so they never pass.
 */
export function cleanupStage(opened: string, argv: readonly string[], configured?: string) {
  if (opened !== stateCommandStage) return opened;
  const at = argv.indexOf("state");
  return at >= 0 && readOnlyStateCommands.has(argv[at + 1] ?? "") ? (configured ?? "") : "";
}
