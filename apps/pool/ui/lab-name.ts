import type { Provider } from "../contract.ts";

// The overview groups by lab, so a subscription provider shows its lab's name (approved overview
// mock). Accounts and connections keep the product name the pool view gives.
const labNames: Record<string, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  xai: "xAI",
};

export interface LabIdentity {
  readonly name: string;
  readonly icons: Provider["icons"];
}

/**
 * A lab's overview name and its provider app's icons, once the pool view lists its provider.
 * Until then there is no identity: never a raw ID, never a guess.
 */
export function labIdentity(
  providers: readonly Provider[] | undefined,
  id: string,
): LabIdentity | undefined {
  const provider = providers?.find((entry) => entry.id === id);
  return provider && { name: labNames[id] ?? provider.name, icons: provider.icons };
}

/** The lab's overview name, or a neutral mark that holds its place until the pool view lands. */
export const labName = (providers: readonly Provider[] | undefined, id: string) =>
  labIdentity(providers, id)?.name ?? "…";
