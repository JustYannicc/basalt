export function architectureChangeErrors(changed: readonly string[], present: ReadonlySet<string>) {
  const errors: string[] = [];
  const boundary = changed.some((file) =>
    /^(?:src\/|packages\/|containers\/|alchemy\.run\.ts$|upstream\.json$|patches\/)/.test(file),
  );
  if (boundary && !changed.some((file) => /^architecture\/.+\.(?:c4|likec4|md)$/.test(file)))
    errors.push("Runtime or stack changes must update architecture in the same PR");
  const stems = new Set(
    changed.flatMap((file) => {
      const match = /^patches\/(\d{4}-.+)\.(?:patch|json)$/.exec(file);
      return match ? [match[1]!] : [];
    }),
  );
  for (const stem of stems) {
    const constraint = `architecture/model/carries/${stem}.c4`;
    const active = present.has(`patches/${stem}.patch`) || present.has(`patches/${stem}.json`);
    if (active && (!present.has(constraint) || !changed.includes(constraint)))
      errors.push(`${stem}: update ${constraint} with this carry's durable constraint`);
    if (!active && present.has(constraint))
      errors.push(`${stem}: remove ${constraint} when retiring the carry`);
  }
  return errors;
}
