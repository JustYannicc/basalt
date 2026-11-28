/**
 * Profile b's bounds, shared by the Worker's control and the profile run's guard, which runs before
 * any credential and imports nothing else. aimock reads a rate only as a plain decimal and ignores
 * any other spelling, `1e-3` included.
 */
export const plainDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
export const maxLatencyMs = 30_000;
