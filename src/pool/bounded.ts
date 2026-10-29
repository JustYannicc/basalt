/** Home reads share a four-request limit within each batch, preserving input order. */
export async function mapBounded<A, B>(
  items: readonly A[],
  read: (item: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await read(items[index]!);
        } catch (error) {
          failure = error;
          failed = true;
          return;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
