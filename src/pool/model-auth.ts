import pg from "pg";

const connectionTimeoutMs = 2_500;
const queryTimeoutMs = 2_500;

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
      googleApiKey,
      apiKey,
      queryKey,
      queryAuthToken,
    ].filter((value) => value !== ""),
  };
}

function extractBearerToken(header: string): string {
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== "bearer") return header;
  // Go's strings.TrimSpace accepts Unicode White_Space, including NEL but not BOM.
  return header.slice(separator + 1).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** Looks up any active Home API key with one parameterized query eligible for the unique api_key index. */
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

  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM api_key
        WHERE api_key = ANY($1::text[]) AND deleted_at IS NULL
      ) AS active`,
      [[...candidates]],
    );
    return result.rows[0]?.active === true;
  } finally {
    if (connected) await client.end();
  }
}
