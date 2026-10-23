import { useState } from "react";
import type { PoolApi } from "./api.ts";
import { Button, Problem } from "./controls.tsx";
import { Header } from "./sign-in-steps.tsx";

const limit = 1024 * 1024;

/** Connect an account from a login file the pool backend exported. */
export function LoginFile({ api, onBack, onConnected }: { api: PoolApi; onBack: () => void; onConnected: () => void }) {
  const [file, setFile] = useState<File>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!file) return;
    setError(undefined);
    if (file.size > limit) return setError("That file is too large to be a login file.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return setError("That file isn't JSON. Pick the login file the pool backend saved.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return setError("That file isn't a login file the pool can read.");
    }
    setBusy(true);
    const result = await api.addLoginFile(parsed);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    onConnected();
  };

  return (
    <>
      <Header
        title="Upload a login file"
        body="A JSON login file the pool backend saved for a subscription, such as one moved from another pool."
      />
      <label className="grid cursor-pointer justify-items-center gap-1 rounded-md border border-dashed border-input px-4 py-6 text-center transition-colors duration-150 hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50">
        <span className="text-sm font-medium">{file ? file.name : "Choose a file"}</span>
        <span className="text-xs text-muted-foreground">{file ? "Choose a different file" : ".json, up to 1 MB"}</span>
        <input
          type="file"
          accept=".json,application/json"
          className="sr-only"
          onChange={(event) => {
            setError(undefined);
            setFile(event.target.files?.[0]);
          }}
        />
      </label>
      {error && <Problem>{error}</Problem>}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button onClick={upload} disabled={!file} busy={busy}>
          Connect
        </Button>
      </div>
    </>
  );
}
