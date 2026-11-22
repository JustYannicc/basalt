/**
 * REHEARSAL-ONLY: which marks the stage Router's serving version runs with, read from its own
 * serving path (the overlay's `/__rehearsal/mark`). A version's metadata names its secrets only, so
 * this is the one read that shows which value a rolled-back version came back with. A new version
 * reaches the edge within seconds, so with `expect` it reads again, bounded, until the mark is that.
 */
import { setTimeout as sleep } from "node:timers/promises";

export const rehearsalMarkPath = "/__rehearsal/mark";

export type MarkRead =
  | { mark: string; unlisted: string; reads: number; expected?: boolean }
  | { status: number; reads: number }
  | { unreadable: string; reads: number };

export async function readRehearsalMark(
  origin: string,
  {
    expect,
    attempts = 12,
    pause = () => sleep(5_000),
    send = fetch,
  }: {
    expect?: string;
    attempts?: number;
    pause?: () => Promise<unknown>;
    send?: typeof fetch;
  } = {},
): Promise<MarkRead> {
  let last: MarkRead = { unreadable: "not read", reads: 0 };
  for (let reads = 1; reads <= attempts; reads++) {
    try {
      const response = await send(`${origin}${rehearsalMarkPath}`, {
        headers: { "cache-control": "no-store" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        last = { status: response.status, reads };
      } else {
        const body = (await response.json()) as { mark?: unknown; unlisted?: unknown };
        if (typeof body.mark !== "string" || typeof body.unlisted !== "string")
          last = { unreadable: "the mark's answer has no mark", reads };
        else {
          last = { mark: body.mark, unlisted: body.unlisted, reads };
          if (expect === undefined) return last;
          if (body.mark === expect) return { ...last, expected: true };
        }
      }
    } catch (error) {
      last = {
        unreadable: (error instanceof Error ? error.message : String(error)).slice(0, 120),
        reads,
      };
    }
    if (reads < attempts) await pause();
  }
  return "mark" in last && expect !== undefined ? { ...last, expected: false } : last;
}

/** The mark a stage built from this checkout commit carries (infrastructure/rehearsal-mark.ts). */
export const releaseMarkOf = (commit: string) => `rehearsal-v1:${commit}`;
