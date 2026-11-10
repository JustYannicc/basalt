import type { ClassificationReport } from "../releases/types.ts";

export type ExecutorMarkerPrecondition = {
  readonly transition: {
    readonly baseGitCommit: string;
    readonly candidateGitCommit: string;
    readonly baseToolsCommit: string;
    readonly candidateToolsCommit: string;
  };
  readonly marker: "public.private_executor_settings.key=version";
  readonly expected: "4.0.29";
};

const toolsTransition = {
  from: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
  to: "2f4c398f3906e0570f0e25a16fa3602329baba29",
};

/** Fresh classification keeps an unfinished cutover gated on retry, until its ledger advances. */
export function executorMarkerPrecondition(
  report: ClassificationReport,
): ExecutorMarkerPrecondition | undefined {
  if (
    !report.databaseChanged ||
    report.base.pins.tools.commit !== toolsTransition.from ||
    report.candidate.pins.tools.commit !== toolsTransition.to
  )
    return undefined;
  return {
    transition: {
      baseGitCommit: report.base.gitCommit,
      candidateGitCommit: report.candidate.gitCommit,
      baseToolsCommit: report.base.pins.tools.commit,
      candidateToolsCommit: report.candidate.pins.tools.commit,
    },
    marker: "public.private_executor_settings.key=version",
    expected: "4.0.29",
  };
}

/** An explicit null overwrites any ambient policy on releases outside the cutover. */
export function executorMarkerPolicy(candidate: string, precondition?: ExecutorMarkerPrecondition) {
  if (!/^[a-f0-9]{40}$/.test(candidate))
    throw new Error("Executor marker policy requires an immutable release candidate");
  if (precondition && precondition.transition.candidateGitCommit !== candidate)
    throw new Error("Executor marker policy does not match the release candidate");
  return JSON.stringify({ candidate, precondition: precondition ?? null });
}
