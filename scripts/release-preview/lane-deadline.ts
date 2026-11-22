/**
 * A standing rehearsal lane's one deadline, read from lane-deadlines.json. Every job of a lane
 * gives its stage the same TEST_STAGE_EXPIRES_AT; a value set per job changes a secret every
 * release, which Cloudflare then refuses to roll back past (10220) and which re-uploads the pool
 * Worker. A lane with no recorded deadline gets none, so its deploys refuse; destroy needs none.
 */
import { readFileSync } from "node:fs";

export function laneDeadline(lane: number, file: string, now = Date.now()) {
  const spec = JSON.parse(readFileSync(file, "utf8")) as { lanes?: Record<string, unknown> };
  const value = spec.lanes?.[String(lane)];
  if (value === undefined) return undefined;
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) ||
    !Number.isFinite(at)
  )
    throw new Error(`Lane ${lane}'s deadline is not a UTC instant`);
  // A deadline already past would stop the stage serving mid-run; the lane needs a new GO.
  if (at <= now) throw new Error(`Lane ${lane}'s deadline has passed`);
  return String(at);
}

if (import.meta.main) {
  const [laneText, file] = process.argv.slice(2);
  const value = laneDeadline(
    Number(laneText),
    file ?? new URL("./lane-deadlines.json", import.meta.url).pathname,
  );
  if (value) console.log(value);
}
