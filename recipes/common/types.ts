export type Verdict = "healthy" | "action" | "unknown" | "withdraw";
/** Only opaque IDs, known codes, numbers and times cross a workflow checkpoint. */
export interface Observation {
  cursor: string;
  at: number;
  verdict: Verdict;
  code: string;
  failures: number;
  successes: number;
  since: number;
  confirmationCursor?: string;
  openingRate?: number;
  lastUnexpectedAt?: number;
  flapping?: boolean;
  sourceAt?: number;
  evidenceUrl?: string;
  attemptedSha?: string;
  decision?: string;
}
export interface Checkpoint {
  revision: number;
  observation: Observation;
  episode: number;
  open: boolean;
  declined: boolean;
  notified: "none" | "claimed" | "submitted" | "sent" | "uncertain" | "refused";
  deliveryAt?: number;
  deliveryAttempt?: string;
  receipt?: string;
  question?: { id: string; app: string; reviewUrl: string; run: string };
  mutedUntil: number;
  ownerRun?: string;
}
export const emptyCheckpoint = (): Checkpoint => ({
  revision: 0,
  observation: {
    cursor: "",
    at: 0,
    verdict: "unknown",
    code: "unconfigured",
    failures: 0,
    successes: 0,
    since: 0,
  },
  episode: 0,
  open: false,
  declined: false,
  notified: "none",
  mutedUntil: 0,
});
/** The caller supplies the named recipe's evaluated condition; this only retains its episode. */
export function remember(previous: Checkpoint, observation: Observation): Checkpoint {
  if (
    observation.at < previous.observation.at ||
    (observation.sourceAt !== undefined &&
      previous.observation.sourceAt !== undefined &&
      observation.sourceAt < previous.observation.sourceAt) ||
    observation.cursor === previous.observation.cursor
  )
    return previous;
  const recovered = observation.verdict === "healthy" || observation.verdict === "withdraw";
  const replaced =
    observation.decision !== undefined && observation.decision !== previous.observation.decision;
  const opening = observation.verdict === "action" && (!previous.open || replaced);
  const {
    receipt: _receipt,
    deliveryAttempt: _attempt,
    question: _question,
    ownerRun: _ownerRun,
    ...withoutQuestion
  } = previous;
  return {
    ...(recovered || opening ? withoutQuestion : previous),
    revision: previous.revision + 1,
    observation: { ...previous.observation, ...observation },
    open: recovered ? false : opening || previous.open,
    episode: previous.episode + (opening ? 1 : 0),
    ...(recovered || opening
      ? {
          declined: false,
          notified: "none",
        }
      : {}),
  };
}
