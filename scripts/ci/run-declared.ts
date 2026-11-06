import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patternForGroup, readDeclarations } from "./declarations.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [id = "", file = ""] = process.argv.slice(2);
const declarations = readDeclarations(root);
const group = declarations.groups[id];
const entry = declarations.files[file];
if (!group?.matrix || !entry) throw new Error("Unknown declared CI run");
const pattern = patternForGroup(id, file, root);
const environment = { ...process.env };
if (entry.fixture === "pool-setup") environment.BASALT_E2E_POOL_SETUP = "1";
if (entry.fixture === "google-routes") {
  const { googleMapsAddition } = await import("../../src/catalog/google-maps/index.ts");
  const directory = join(root, ".generated/ci");
  const path = join(directory, "maps-source.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const origin = "https://routes-fixture.invalid";
  const addition = googleMapsAddition(origin);
  writeFileSync(path, JSON.stringify({ origin, entry: addition.entry, source: addition.source }), {
    mode: 0o600,
  });
  environment.BASALT_E2E_ROUTES = "1";
  environment.BASALT_E2E_ROUTES_SOURCE_FILE = path;
}
const flags: Record<string, string[]> = {
  managed: [],
  "rate-limited": ["--auth-rate-limit"],
  "rolled-back": ["--rollback"],
  "oauth-proxy-preview": ["--oauth-proxy-preview"],
  "manual-cron": ["--manual-cron"],
};
const result = spawnSync(
  "bun",
  ["run", "e2e:" + group.target, "--test-name", pattern, "--workers", "1", ...flags[group.mode]!],
  {
    cwd: join(root, ".upstream"),
    env: environment,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
