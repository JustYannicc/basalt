import { spawnSync } from "node:child_process";

/** Docker resources are fixture-owned; builder cache is shared, so an active container vetoes it. */
export function cleanupFixtureDocker(input: {
  containers: readonly string[];
  network: string | undefined;
  image: string | undefined;
  timeout: number;
}): unknown[] {
  const failures: unknown[] = [];
  const run = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: input.timeout });
    if (result.status !== 0) throw result.error ?? new Error(result.stderr || `docker ${args[0]} failed`);
    return result.stdout.trim();
  };
  for (const name of [...input.containers].reverse()) {
    try { run(["rm", "--force", "--volumes", name]); console.log(`Removed container ${name}`); }
    catch (error) { failures.push(error); }
  }
  if (input.network) {
    try { run(["network", "rm", input.network]); console.log(`Removed network ${input.network}`); }
    catch (error) { failures.push(error); }
  }
  let running: string;
  try { running = run(["ps", "--quiet"]); }
  catch (error) { failures.push(error); return failures; }
  if (running) {
    console.log("Skipped image and builder cleanup while Docker containers are running");
    return failures;
  }
  if (input.image) {
    const exists = spawnSync("docker", ["image", "inspect", input.image], {
      encoding: "utf8", timeout: input.timeout,
    });
    if (exists.status === 0) {
      try { run(["image", "rm", input.image]); console.log(`Removed image ${input.image}`); }
      catch (error) { failures.push(error); }
    }
  }
  try { run(["builder", "prune", "-f"]); }
  catch (error) { failures.push(error); }
  return failures;
}
