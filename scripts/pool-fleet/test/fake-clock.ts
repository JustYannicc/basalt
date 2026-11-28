/** A clock the lane's waits move, so the handover bound runs in no real time; signed commands stay fresh. */
export const fakeClock = () => {
  const clock = { start: Date.now(), at: Date.now(), sleeps: [] as number[] };
  return {
    clock,
    deps: {
      now: () => clock.at,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        clock.at += ms;
      },
    },
  };
};
