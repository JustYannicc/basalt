import { Effect } from "effect";
import type { Worker } from "alchemy/Cloudflare";
import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";

export const attributes = (name: string): Worker["Attributes"] => ({
  workerId: name,
  workerName: name,
  accountId: "fixture",
  namespace: undefined,
  logpush: undefined,
  url: undefined,
  urls: [],
  domain: undefined,
  tags: [],
  durableObjectNamespaces: {},
  routes: [],
  crons: [],
  hash: { assets: undefined, bundle: "bundle", input: "input", additionalWorkspaces: undefined },
});

export const preparedUpload = (id = "Api"): PreparedWorkerUpload => ({
  id,
  fqn: id,
  request: {
    accountId: "fixture",
    scriptName: id,
    metadata: {
      mainModule: "main.js",
      compatibilityDate: "2026-09-08",
      compatibilityFlags: [
        "nodejs_compat",
        "global_fetch_strictly_public",
        "enable_request_signal",
        "new_module_registry",
      ],
      bindings: [{ type: "plain_text", name: "SETTING", text: "frozen-value" }],
      migrations: { oldTag: "1", newTag: "2", newSqliteClasses: [] },
      tags: ["alchemy:migration-tag:2"],
    },
    files: [new File(["export default {}"], "main.js", { type: "application/javascript+module" })],
  },
  previous: attributes(id),
  proposed: attributes(id),
  previousSettings: { bindings: [], tags: ["alchemy:migration-tag:1"] },
  props: {},
  previousProps: {},
  activate: () => Effect.succeed(attributes(id)),
});
