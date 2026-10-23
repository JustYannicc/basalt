import { spawnSync } from "node:child_process";

export function run(command: string, args: string[], cwd?: string, env = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}
