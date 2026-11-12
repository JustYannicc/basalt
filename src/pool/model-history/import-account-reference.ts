export const importAccountPrefix = "i:";

// The non-hex prefix distinguishes mapped imports after current bindings disappear.
// Keep the existing 64-character column and 248 bits of the Home account hash.
export const importAccountReference = (homeReference: string) =>
  `${importAccountPrefix}${homeReference.slice(0, 64 - importAccountPrefix.length)}`;

export const accountHistoryReferences = (homeReference: string) => [
  homeReference,
  importAccountReference(homeReference),
];
