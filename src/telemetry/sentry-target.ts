/** Runtime Sentry destinations. Empty optional deployment values disable their transport. */
export interface SentryEnv {
  SENTRY_DSN?: string;
  /** Copy this exact endpoint from Sentry Project Settings → Client Keys (DSN). */
  SENTRY_OTLP_ENDPOINT?: string;
}

interface ParsedDsn {
  readonly publicKey: string;
  readonly host: string;
  readonly projectId: string;
}

export interface SentryEnvelopeTarget {
  readonly url: string;
  readonly authHeader: string;
}

export interface SentryOtlpTarget {
  readonly url: string;
  readonly authHeader: string;
}

/** Accept only a public DSN on Sentry's EU ingest domain and one numeric project. */
function parseDsn(value: unknown): ParsedDsn | undefined {
  if (typeof value !== "string" || value === "" || value.trim() === "") return undefined;
  const match = /^https:\/\/([A-Za-z0-9_-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.ingest\.de\.sentry\.io)\/(\d+)$/i.exec(value);
  if (!match) return undefined;
  try {
    const url = new URL(value);
    const [, publicKey, host, projectId] = match;
    if (
      url.protocol !== "https:" || url.username !== publicKey || url.password !== "" ||
      url.port !== "" || url.search !== "" || url.hash !== "" ||
      url.hostname.toLowerCase() !== host!.toLowerCase() || url.pathname !== `/${projectId}`
    ) return undefined;
    return { publicKey: publicKey!, host: host!.toLowerCase(), projectId: projectId! };
  } catch {
    return undefined;
  }
}

/** Public so the feedback status endpoint can hide submission when Sentry is unavailable. */
export function validSentryDsn(value: unknown): boolean {
  return parseDsn(value) !== undefined;
}

/** Sentry's envelope path is the standard endpoint associated with a DSN project. */
export function sentryEnvelopeTarget(env: SentryEnv): SentryEnvelopeTarget | undefined {
  const dsn = parseDsn(env.SENTRY_DSN);
  if (!dsn) return undefined;
  return {
    url: `https://${dsn.host}/api/${dsn.projectId}/envelope/`,
    authHeader: `Sentry sentry_version=7, sentry_client=basalt/1, sentry_key=${dsn.publicKey}`,
  };
}

/**
 * Sentry publishes a separate OTLP URL in Client Keys (DSN); it is not derivable from the DSN
 * under the documented contract. Only allow the configured URL on that same EU ingest host.
 */
export function sentryOtlpTarget(env: SentryEnv): SentryOtlpTarget | undefined {
  const dsn = parseDsn(env.SENTRY_DSN);
  const endpoint = env.SENTRY_OTLP_ENDPOINT;
  if (!dsn || typeof endpoint !== "string" || endpoint === "" || endpoint.trim() === "") return undefined;
  const match = /^https:\/\/([^/?#]+)(\/[^?#]+)$/i.exec(endpoint);
  if (!match || match[1]!.includes("@") || match[1]!.includes(":")) return undefined;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" ||
      url.search !== "" || url.hash !== "" || url.hostname.toLowerCase() !== dsn.host
    ) return undefined;
    return { url: url.href, authHeader: `sentry sentry_key=${dsn.publicKey}` };
  } catch {
    return undefined;
  }
}
