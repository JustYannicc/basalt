import { Cause, Exit } from "effect";
import type { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";

export async function releaseOutcome(
  evidence: ReturnType<typeof releaseEvidence>,
  summaryPath: string | undefined,
  run: () => Promise<Exit.Exit<unknown, unknown>>,
) {
  let disposition: "complete" | "failed" = "failed";
  try {
    const result = await run();
    if (Exit.isFailure(result)) {
      const failure = await evidence.failure(Cause.squash(result.cause));
      await reportRefusal(failure, summaryPath);
      return 1;
    }
    disposition = "complete";
    return 0;
  } finally {
    // Refusal reporting can itself fail after infrastructure has already changed.
    await evidence.summary(summaryPath, disposition);
  }
}
