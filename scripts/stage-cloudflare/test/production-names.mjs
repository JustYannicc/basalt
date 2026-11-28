// The names production's records use, derived from the release stack's and its tooling's source,
// so ownership.mjs's lists cannot fall behind a new release resource unnoticed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const tracked = (...paths) =>
  execFileSync("git", ["ls-files", "--", ...paths], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]s$/u.test(file));
const shipped = (file) => !/\.test\.|\/test\/|fixture/u.test(file);
const releaseSource = tracked("alchemy.run.ts", "infrastructure", "src").filter(shipped);

/**
 * The release stack's own resource ids (Cloudflare.Worker("PoolWorker"), ...), as Alchemy names
 * them: lower case, after the app name and the stage.
 */
export const releaseIds = [
  ...new Set(
    releaseSource.flatMap((file) =>
      [
        ...read(file).matchAll(
          /\b(?:Worker|Container|DurableObject|DurableObjectNamespace|Hyperdrive|R2Bucket|KVNamespace|Queue|D1Database|Workflow|Website|SecretsStore)\(\s*"([A-Za-z][A-Za-z0-9]*)"/gu,
        ),
      ].map((match) => match[1].toLowerCase()),
    ),
  ),
];
/**
 * Every name the release stack and its operators spell out in full, and the production and
 * rehearsal names the release tooling uses.
 */
export const releaseLiterals = [
  ...new Set(
    [...releaseSource, ...tracked("scripts/release", "scripts/pool-fleet")].flatMap((file) =>
      [...read(file).matchAll(/["'`](basalt-[a-z0-9]+(?:-[a-z0-9]+)*)/gu)].map((match) => match[1]),
    ),
  ),
];
const releaseStages = [
  "production",
  "test-rehearsal-2",
  "test-rehearsal-20",
  "test-pr-7",
  "preview-pr-7",
];
/** Every name above, every name the stack composes from its ids, and a few more of its shapes. */
export const productionNames = [
  ...releaseLiterals,
  ...releaseStages.flatMap((stage) =>
    releaseIds.flatMap((id) => [`basalt-${stage}-${id}`, `basalt-${id}-${stage}`]),
  ),
  "basalt",
  "basalt-api",
  "basalt-pool",
  "basalt-pool-runtime-blue",
  "basalt-poolcontainer-production-0123abcd",
];
