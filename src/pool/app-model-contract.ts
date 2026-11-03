export const appModelPath = "/__models/v1/request";
export const appModelPrefix = "sb-app-model1";
const slot = "[A-Za-z][A-Za-z0-9_-]{0,47}";
const labelPattern = new RegExp(`^bam1:(app_[A-Za-z0-9_-]{1,64}):(${slot}):[a-f0-9]{24}$`);
/** Only server-generated app metadata is extracted; ordinary user key labels stay private. */
export function appModelLabel(app: string, requirement: string, nonce: string) {
  const label = `bam1:${app}:${requirement}:${nonce.replaceAll("-", "").slice(0, 24)}`;
  if (label.length > 128 || !labelPattern.test(label)) throw new Error("Invalid app model identity");
  return label;
}
export function parseAppModelLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = labelPattern.exec(value);
  return match ? { app: match[1]!, requirement: match[2]! } : undefined;
}
export const appModelLabelSqlPattern = `^bam1:(app_[A-Za-z0-9_-]{1,64}):(${slot}):[a-f0-9]{24}$`;
