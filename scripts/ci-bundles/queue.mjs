export async function runQueue(items, concurrency, run) {
  const pending = [...items];
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    const failures = [];
    for (;;) {
      const item = pending.shift();
      if (!item) return failures;
      try { await run(item); }
      catch (error) { failures.push({ item, error }); }
    }
  }));
  return workers.flatMap((worker) => worker.status === "fulfilled" ? worker.value
    : [{ error: worker.reason }]);
}
