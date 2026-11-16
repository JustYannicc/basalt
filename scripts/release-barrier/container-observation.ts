import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { unsupportedContainerObservation } from "./container-diagnostics.ts";
export { containerAttributes } from "../../src/pool/runtime-provider/application.ts";

export function decodeApplication(value: unknown) {
  try {
    return decodeProviderApplication(value);
  } catch (error) {
    throw unsupportedContainerObservation(error);
  }
}
