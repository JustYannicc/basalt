import { liveDeadline } from "../database-budget-readiness.ts";

export interface ServingClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  deadline(milliseconds: number): ReturnType<typeof liveDeadline>;
}

export const servingClock: ServingClock = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deadline: liveDeadline,
};
