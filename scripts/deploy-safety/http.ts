import { SafetyGateError } from "./contracts.ts";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type JsonReply = {
  status: number;
  headers: Headers;
  body: unknown;
};

export async function requestJson(
  fetcher: Fetcher,
  provider: string,
  url: string,
  init: RequestInit,
  acceptedStatuses: readonly number[] = [200],
): Promise<JsonReply> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "error", ...init });
  } catch {
    throw new SafetyGateError(`${provider} request failed before a response`);
  }

  const raw = await response.text();
  if (!acceptedStatuses.includes(response.status))
    throw new SafetyGateError(`${provider} request failed with HTTP ${response.status}`);
  if (!raw) throw new SafetyGateError(`${provider} returned an empty response`);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new SafetyGateError(`${provider} returned invalid JSON`);
  }
  return { status: response.status, headers: response.headers, body };
}

export function cloudflareResult(value: unknown, operation: string): { result: unknown; resultInfo: unknown } {
  const response = record(value, `Cloudflare ${operation} response`);
  if (response.success !== true) throw new SafetyGateError(`Cloudflare ${operation} was not successful`);
  if (!Array.isArray(response.errors) || response.errors.length > 0)
    throw new SafetyGateError(`Cloudflare ${operation} returned an error`);
  return { result: response.result, resultInfo: response.result_info };
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SafetyGateError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SafetyGateError(`${label} is missing`);
  return value;
}

export function integerField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new SafetyGateError(`${label} is invalid`);
  return value;
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function withBearer(token: string, headers: Record<string, string> = {}): Record<string, string> {
  if (!token.trim()) throw new SafetyGateError("Provider credential is missing");
  return { Authorization: `Bearer ${token}`, ...headers };
}

export function withPlanetScaleServiceToken(
  tokenId: string,
  token: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (!tokenId.trim() || !token.trim()) throw new SafetyGateError("PlanetScale service token credentials are missing");
  return { Authorization: `${tokenId}:${token}`, ...headers };
}
