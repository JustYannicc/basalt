export interface ProbeRuntimeIdentity {
  source: "legacy" | "selected";
  running: boolean | null;
  applicationVersion: string | null;
  bootId: string | null;
  expectedBootId: string | null;
  imageInput: string;
}

export function probeRuntimeContext(input: ProbeRuntimeIdentity | undefined) {
  const identity = (value: unknown, pattern: RegExp) =>
    typeof value === "string" && pattern.test(value) ? value : "unavailable";
  const source =
    input?.source === "legacy" || input?.source === "selected" ? input.source : "unavailable";
  return {
    source,
    running: typeof input?.running === "boolean" ? input.running : null,
    application_version: identity(input?.applicationVersion, /^[1-9][0-9]{0,15}$/),
    boot_id: identity(
      input?.bootId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    ),
    expected_boot_id: identity(
      input?.expectedBootId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    ),
    image_input: identity(input?.imageInput, /^[a-f0-9]{16,64}$/),
    image_input_source:
      source === "selected"
        ? "selected"
        : source === "legacy"
          ? "worker_configuration"
          : "unavailable",
  };
}
