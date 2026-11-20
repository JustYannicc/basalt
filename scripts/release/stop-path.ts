/**
 * How the stuck runtime was stopped, from the pool Worker's own log: each forced stop writes one
 * `POOL_RUNTIME_FORCED_STOP` line whose `path` is a fixed word (`graceful_exit`,
 * `destroy_after_grace`, ...). A release that did not heal names it; nothing else of a line is kept.
 */
export const STOP_NEEDLE = "POOL_RUNTIME_FORCED_STOP";
const PATH_WORD = /^[a-z][a-z_]{0,40}$/u;

/** The stop paths in a Workers Logs query answer, in order. */
export function stopPaths(answer: string): string[] {
  const plain = answer.replace(/\\"/gu, '"');
  const paths: string[] = [];
  for (const match of plain.matchAll(
    new RegExp(`${STOP_NEEDLE}[^{]{0,8}(\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\})`, "gu"),
  ))
    try {
      const path = (JSON.parse(match[1]!) as { path?: unknown }).path;
      paths.push(typeof path === "string" && PATH_WORD.test(path) ? path : "unreadable");
    } catch {
      paths.push("unreadable");
    }
  return paths.slice(0, 50);
}

/** The pool Worker's stop paths since `from` (epoch ms), or why they could not be read. */
export async function readStopPaths(input: {
  readonly accountId: string;
  readonly token: string;
  readonly script: string;
  readonly from: number;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly paths: readonly string[] } | { readonly unread: string }> {
  const send = input.fetch ?? fetch;
  try {
    const response = await send(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          queryId: `release-forced-stop-${Date.now()}`,
          timeframe: { from: input.from, to: Date.now() },
          view: "events",
          limit: 50,
          parameters: {
            filters: [
              { key: "$metadata.service", operation: "eq", type: "string", value: input.script },
            ],
            needle: { value: STOP_NEEDLE, isRegex: false, matchCase: true },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return { unread: `Workers Logs answered HTTP ${response.status}` };
    return { paths: stopPaths(await response.text()) };
  } catch (error) {
    return { unread: error instanceof Error ? error.name : "unknown" };
  }
}
