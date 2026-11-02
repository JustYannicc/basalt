import { workflowFields } from "./workflow-fields.ts";
import { configuration } from "./configuration.ts";
/** Consent binds to this pinned source's configuration, including each workflow's destination formatter and quiet hours. */
export async function configurationRevision() {
  const encoded = JSON.stringify({ configuration, workflowFields }, (_key, value: unknown) =>
    typeof value === "function" ? value.toString() : value,
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
