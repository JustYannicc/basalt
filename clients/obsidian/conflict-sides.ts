import type { Conflict } from "./types.ts";

export function conflictSides(file: Conflict["conflicts"][number]) {
  // The drive merges main (ours) with the submitting device's writer branch (theirs).
  return { deviceAt: file.theirs, cloudAt: file.ours };
}
