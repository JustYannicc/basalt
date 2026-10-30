import pg from "pg";

const connectionTimeoutMs = 2_500;
const queryTimeoutMs = 2_500;
const lookupTimeoutMs = 6_000;

export interface HomeApiKeyCandidates {
  readonly supplied: boolean;
  readonly values: readonly string[];
}

export type HomeApiKeyLookup = (
  connectionString: string,
  candidates: readonly string[],
) => Promise<boolean>;

/** Mirrors Home's credential candidate order and Bearer/raw Authorization fallback. */
export function homeApiKeyCandidates(request: Request): HomeApiKeyCandidates {
  const authorization = request.headers.get("Authorization") ?? "";
  const googleApiKey = request.headers.get("X-Goog-Api-Key") ?? "";
  const apiKey = request.headers.get("X-Api-Key") ?? "";
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key") ?? "";
  const queryAuthToken = url.searchParams.get("auth_token") ?? "";

  return {
    supplied:
      authorization !== "" ||
      googleApiKey !== "" ||
      apiKey !== "" ||
      queryKey !== "" ||
      queryAuthToken !== "",
    values: [
      extractBearerToken(authorization),
      trimSpace(googleApiKey),
      trimSpace(apiKey),
      trimSpace(queryKey),
      trimSpace(queryAuthToken),
    ].filter((value) => value !== ""),
  };
}

function extractBearerToken(header: string): string {
  header = trimSpace(header);
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== "bearer") return header;
  return trimSpace(header.slice(separator + 1));
}

function trimSpace(value: string): string {
  // Go's strings.TrimSpace accepts Unicode White_Space, including NEL but not BOM.
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** Home stops at its first active candidate; later malformed values must not spoil that match. */
export async function hasActiveHomeApiKey(
  connectionString: string,
  candidates: readonly string[],
): Promise<boolean> {
  if (!connectionString) throw new Error("Pool database URL is missing");
  if (candidates.length === 0) return false;

  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: connectionTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
  });
  // A request owns this connection; query/connect promises carry errors to the caller.
  client.on("error", () => {});

  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // pg@8.16.3's graceful end can wait on a half-open connection.
      try { client.connection.stream.destroy(); } catch { /* Still refuse the timed-out lookup. */ }
      reject(new Error("Pool authentication deadline exceeded"));
    }, lookupTimeoutMs);
  });
  const query = async () => {
    try {
      await client.connect();
      for (const candidate of candidates) {
        if (expired) throw new Error("Pool authentication deadline exceeded");
        const result = await client.query<{ active: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM api_key
            WHERE api_key = $1 AND deleted_at IS NULL
          ) AS active`,
          [candidate],
        );
        if (result.rows[0]?.active === true) return true;
      }
      return false;
    } finally {
      await client.end();
    }
  };
  try {
    return await Promise.race([query(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
