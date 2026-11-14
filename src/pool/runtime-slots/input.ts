import { Schema } from "effect";
import { SlotRefused } from "./contract.ts";

/** Only caller decoding failures are refusals; service and storage defects must escape. */
export function runtimeInput<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (Schema.isSchemaError(error) || error instanceof SyntaxError)
      throw new SlotRefused("identity");
    throw error;
  }
}
