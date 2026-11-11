import type { SyncInventory } from "./snapshot.ts";

export function compareSyncInventories(before: SyncInventory, after: SyncInventory) {
  const previous = new Map(before.carries.map((carry) => [carry.identity, carry]));
  const current = new Map(after.carries.map((carry) => [carry.identity, carry]));
  const added = after.carries.filter((carry) => !previous.has(carry.identity));
  const removed = before.carries.filter((carry) => !current.has(carry.identity));
  const changed = after.carries.flatMap((carry) => {
    const prior = previous.get(carry.identity);
    if (!prior) return [];
    const oldFields = new Map(Object.entries(prior));
    const newFields = new Map(Object.entries(carry));
    const changes = [...new Set([...oldFields.keys(), ...newFields.keys()])]
      .sort()
      .filter(
        (property) =>
          JSON.stringify(oldFields.get(property)) !== JSON.stringify(newFields.get(property)),
      )
      .map((property) => ({
        property,
        before: oldFields.get(property) ?? null,
        after: newFields.get(property) ?? null,
      }));
    return changes.length ? [{ identity: carry.identity, changes }] : [];
  });
  const unchanged = after.carries
    .filter((carry) => {
      const prior = previous.get(carry.identity);
      return prior !== undefined && JSON.stringify(prior) === JSON.stringify(carry);
    })
    .map((carry) => carry.identity);
  const prefixLength = Math.min(before.carries.length, after.carries.length);
  let reusablePrefix = 0;
  const upstreamChanged = JSON.stringify(before.upstream) !== JSON.stringify(after.upstream);
  if (!upstreamChanged)
    while (
      reusablePrefix < prefixLength &&
      JSON.stringify(before.carries[reusablePrefix]) ===
        JSON.stringify(after.carries[reusablePrefix])
    )
      reusablePrefix++;
  const oldAuxiliary = new Map(before.auxiliary.map((entry) => [entry.file, entry.sha256]));
  const newAuxiliary = new Map(after.auxiliary.map((entry) => [entry.file, entry.sha256]));
  const auxiliaryChanges = [...new Set([...oldAuxiliary.keys(), ...newAuxiliary.keys()])]
    .sort()
    .flatMap((file) => {
      const oldDigest = oldAuxiliary.get(file) ?? null;
      const newDigest = newAuxiliary.get(file) ?? null;
      return oldDigest === newDigest ? [] : [{ file, before: oldDigest, after: newDigest }];
    });
  const oldRepository = new Map(before.repositoryInputs.map((entry) => [entry.path, entry]));
  const newRepository = new Map(after.repositoryInputs.map((entry) => [entry.path, entry]));
  const repositoryChanges = [...new Set([...oldRepository.keys(), ...newRepository.keys()])]
    .sort()
    .flatMap((file) => {
      const prior = oldRepository.get(file) ?? null;
      const current = newRepository.get(file) ?? null;
      return JSON.stringify(prior) === JSON.stringify(current)
        ? []
        : [{ file, before: prior, after: current }];
    });
  return {
    before: { commit: before.basalt.commit, inputSha256: before.inputSha256 },
    after: { commit: after.basalt.commit, inputSha256: after.inputSha256 },
    upstreamChanged,
    registryChanged: before.registry.sha256 !== after.registry.sha256,
    added,
    removed,
    changed,
    unchanged,
    auxiliaryChanges,
    repositoryChanges,
    reusablePrefix,
    firstInvalidatedCarry:
      after.carries[reusablePrefix]?.file ?? before.carries[reusablePrefix]?.file ?? null,
  };
}
