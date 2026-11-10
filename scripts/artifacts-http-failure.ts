export interface ArtifactsResponse {
  readonly status: number;
  readonly codes: readonly number[];
  readonly ray?: string;
}

export class ArtifactsHttpFailure extends Error {
  readonly response: ArtifactsResponse;
  readonly onlyErrorCode: number | undefined;

  constructor(message: string, response: ArtifactsResponse, onlyErrorCode?: number) {
    super(message);
    this.response = response;
    this.onlyErrorCode = onlyErrorCode;
  }
}

export const failureHeaders = {
  "cf-ray": /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i,
  "cf-mitigated": /^challenge$/,
  "retry-after": /^\d{1,10}$/,
  "x-ratelimit-limit": /^\d{1,10}$/,
  "x-ratelimit-remaining": /^\d{1,10}$/,
  "x-ratelimit-reset": /^\d{1,10}$/,
};

async function failureBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const bytes = new Uint8Array(64 * 1024);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
      // Stop at the ceiling without requesting another chunk just to discover EOF.
      if (value.byteLength >= bytes.byteLength - length) {
        void reader.cancel().catch(() => {});
        return;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function artifactsHttpFailure(
  response: Response,
  message: string,
  body?: unknown,
): Promise<Error> {
  const envelope: unknown = body ?? (await failureBody(response).catch(() => undefined));
  const errors =
    typeof envelope === "object" && envelope !== null && "errors" in envelope
      ? envelope.errors
      : undefined;
  const codes = new Set<number>();
  if (Array.isArray(errors)) {
    for (const entry of errors.slice(0, 10)) {
      if (typeof entry !== "object" || entry === null || !("code" in entry)) continue;
      const code: unknown = entry.code;
      if (typeof code === "number" && Number.isSafeInteger(code) && code > 0 && code <= 99_999_999)
        codes.add(code);
    }
  }
  // Retry eligibility uses every error, independently of the capped diagnostic list.
  const firstCode = [...codes][0];
  const onlyErrorCode =
    firstCode !== undefined &&
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (entry) =>
        typeof entry === "object" && entry !== null && "code" in entry && entry.code === firstCode,
    )
      ? firstCode
      : undefined;
  const headers: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(failureHeaders)) {
    const value = response.headers.get(name);
    if (value !== null && pattern.test(value)) headers[name] = value;
  }
  // Keep only numeric quota parameters; provider-chosen names may contain private data.
  for (const [name, pattern] of [
    ["ratelimit", /^"[^"\r\n]{1,64}"\s*;\s*r=(\d{1,10})\s*;\s*t=(\d{1,10})$/],
    ["ratelimit-policy", /^"[^"\r\n]{1,64}"\s*;\s*q=(\d{1,10})\s*;\s*w=(\d{1,10})$/],
  ] as const) {
    const value = response.headers.get(name);
    if (value === null || value.length > 256) continue;
    const quotas = value
      .split(",")
      .slice(0, 4)
      .flatMap((item) => {
        const match = pattern.exec(item.trim());
        if (!match) return [];
        return [
          name === "ratelimit" ? `r=${match[1]};t=${match[2]}` : `q=${match[1]};w=${match[2]}`,
        ];
      });
    if (quotas.length) headers[name] = quotas.join(", ");
  }
  return new ArtifactsHttpFailure(
    `${message}; diagnostics=${JSON.stringify({ codes: [...codes], headers })}`,
    {
      status: response.status,
      codes: [...codes],
      ...(headers["cf-ray"] ? { ray: headers["cf-ray"] } : {}),
    },
    onlyErrorCode,
  );
}
