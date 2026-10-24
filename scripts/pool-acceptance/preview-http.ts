import { AcceptanceFailure, TransportFailure } from "./types.ts";

const responseLimitBytes = 1_048_576;
const requestLimitBytes = 1_048_576;

export type PreviewHttpOptions = {
  readonly stageRouter?: PreviewStageRouter;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
};

export type PreviewStageRouter = {
  readonly fetch: typeof fetch;
};

export class PreviewHttpClient {
  readonly origin: string;
  private readonly stageRouter: PreviewStageRouter;
  private readonly requestTimeoutMs: number;
  private readonly cookies = new Map<string, string>();

  constructor(origin: string, options: PreviewHttpOptions = {}) {
    this.origin = origin;
    this.stageRouter = options.stageRouter ?? { fetch: options.fetch ?? globalThis.fetch };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  headers(extra: HeadersInit = {}, includeCookies = true): Headers {
    const headers = new Headers(extra);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    const cookie = includeCookies ? this.cookieHeader() : undefined;
    if (cookie) headers.set("Cookie", cookie);
    return headers;
  }

  requireCookie(): string {
    const cookie = this.cookieHeader();
    if (!cookie) throw new AcceptanceFailure("Sign in to the preview before using its pool");
    return cookie;
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async request(path: string, init: RequestInit, label: string): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new AcceptanceFailure(`${label} left the configured preview origin`);
    try {
      const response = await this.stageRouter.fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.floor(this.requestTimeoutMs))),
      });
      this.captureCookies(response);
      return response;
    } catch {
      throw new TransportFailure(`${label} did not return an HTTP response`);
    }
  }

  async expectOk(response: Response, label: string): Promise<void> {
    if (response.ok) return;
    const status = response.status;
    await this.discardBody(response);
    throw new AcceptanceFailure(`${label} returned HTTP ${status}`);
  }

  async readJson(response: Response, label: string): Promise<unknown> {
    try {
      return JSON.parse(await this.responseText(response, label)) as unknown;
    } catch (error) {
      if (error instanceof AcceptanceFailure) throw error;
      throw new AcceptanceFailure(`${label} did not return valid JSON`);
    }
  }

  encodeJson(value: unknown, label: string): string {
    try {
      const body = JSON.stringify(value);
      if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > requestLimitBytes) {
        throw new AcceptanceFailure(`${label} exceeded the request size limit`);
      }
      return body;
    } catch (error) {
      if (error instanceof AcceptanceFailure) throw error;
      throw new AcceptanceFailure(`${label} was not valid JSON`);
    }
  }

  async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // The body is deliberately omitted from diagnostics.
    }
  }

  private cookieHeader(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") : undefined;
  }

  private captureCookies(response: Response): void {
    for (const line of this.setCookieValues(response.headers)) {
      const pair = line.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/;\s*max-age\s*=\s*0(?:;|$)/i.test(line) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private setCookieValues(headers: Headers): string[] {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    if (typeof extended.getSetCookie === "function") return extended.getSetCookie();
    const combined = headers.get("set-cookie");
    return combined ? combined.split(/,(?=\s*[^;,\s]+=)/) : [];
  }

  private async responseText(response: Response, label: string): Promise<string> {
    if (!response.body) throw new AcceptanceFailure(`${label} did not return a response body`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > responseLimitBytes) {
          await reader.cancel();
          throw new AcceptanceFailure(`${label} exceeded the response size limit`);
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof AcceptanceFailure) throw error;
      throw new AcceptanceFailure(`${label} did not return a readable response`);
    } finally {
      reader.releaseLock();
    }
  }
}
