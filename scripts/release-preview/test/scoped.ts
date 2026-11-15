import type { ScopedPreviewResult } from "../../pool-acceptance/preview-scoped-result.ts";
import type { PreviewPoolEvidence } from "../scoped-receipt.ts";

export function scopedSmoke(): ScopedPreviewResult {
  return {
    version: 2,
    mode: "preview-scoped",
    signIn: true,
    poolEmpty: true,
    cleanup: true,
    clients: (["claude", "codex"] as const).map((client) => ({
      client,
      transport: client === "claude" ? "live" : "synthetic",
      exit: 0,
      timeout: false,
      modelRequest: true,
      toolSearch: true,
      undo: true,
      revoke: true,
      ...(client === "codex" ? { chatgptAuthPreserved: true, refreshTokenUntouched: true } : {}),
    })),
  };
}
export function poolEvidence(): PreviewPoolEvidence {
  return {
    model: "claude-opus-5-5",
    requests: 2,
    planQuotaChecked: true,
    extraUsageDisabled: true,
    revoked: true,
    unauthorized: true,
  };
}
