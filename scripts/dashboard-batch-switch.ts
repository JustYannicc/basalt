import { readFileSync, writeFileSync } from "node:fs";

/** Disable only the request-local cache; its native fallback and other middleware stay intact. */
export const disableDashboardBatchAuthentication = (middleware: string) => {
  const original = readFileSync(middleware, "utf8");
  const layer = /^  batchAuthentication\.layer,\r?\n/gm;
  if ([...original.matchAll(layer)].length !== 1)
    throw new Error(`Expected one dashboard batch middleware layer in ${middleware}`);
  const disabled = original.replace(layer, "");
  writeFileSync(middleware, disabled);
  return () => {
    if (readFileSync(middleware, "utf8") !== disabled)
      throw new Error(`Dashboard batch middleware changed during profiling: ${middleware}`);
    writeFileSync(middleware, original);
  };
};
