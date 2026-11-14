import type { Provider } from "../contract.ts";

// Names come from the pool view. Its pending or missing entries keep the existing neutral mark.
export function summaryLabName(providers: readonly Provider[], id: string | null) {
  return id === null
    ? "Unknown lab"
    : (providers.find((provider) => provider.id === id)?.name ?? "…");
}
