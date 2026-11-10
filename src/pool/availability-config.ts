export const availabilityCron = "* * * * *";

export function validProbeTarget(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/.test(value);
}
