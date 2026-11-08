export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type Http = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpReply>;
export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Server returned an invalid object");
  return { ...value };
};
export const text = (value: Record<string, unknown>, key: string) => {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0 || item.length > 16 * 1024 * 1024)
    throw new Error(`Server omitted ${key}`);
  return item;
};
export const number = (value: Record<string, unknown>, key: string) => {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Server omitted ${key}`);
  return item;
};
export function endpoint(input: string, allowLoopback = false) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (allowLoopback &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Use an HTTPS Basalt connection link");
  return url;
}
export function json(reply: HttpReply, limit = 64 * 1024): unknown {
  if (reply.body.length > limit) throw new Error("Server reply exceeds the device response limit");
  return JSON.parse(reply.body);
}
