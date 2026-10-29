// The home page volcano's size and timing, shared by its renderer (scripts/site-volcano.ts) and
// the page.

/** Cells across and down; the page scales them up with crisp edges. */
export const width = 128;
export const height = 144;
export const loopSeconds = 4.8;
/** A whole number of loops, so when both start together the loop is on its first frame as the intro steps aside. */
export const introSeconds = 2 * loopSeconds;
