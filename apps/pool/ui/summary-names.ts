import type { Provider } from "../contract.ts";
import { labName } from "./lab-name.ts";

// Lab names wait for the pool view; its pending or missing entries keep the neutral mark.
export function summaryLabName(providers: readonly Provider[], id: string | null) {
  return id === null ? "Unknown lab" : labName(providers, id);
}
