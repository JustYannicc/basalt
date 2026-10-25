/**
 * Bun arguments that run the workspace's local Alchemy CLI. `bun exec` treats only its first argument as
 * the script, so `bun exec alchemy deploy …` runs a bare `alchemy` that prints help and exits 0.
 * `bun run` resolves the local bin, passes every argument and returns Alchemy's exit code.
 */
export const alchemyArgs = (...args: string[]): string[] => ["run", "alchemy", ...args];
