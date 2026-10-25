/** Inject one violation into a newly discovered app and run the same command as CI. */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostVersion } from "./host.mjs";
import { limits } from "./manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(root, "apps/app-conventions-proof");
const valid = `import { defineApp, mutation, object, router } from 'apps';
const update = mutation({ input: object({}), approval: undefined }, async (ctx) => ctx.fetch('https://example.com'));
export default defineApp({}, { tools: router({ update }) });\n`;
export const cases = [
  "global-alias",
  "mutation-reexport",
  "mutation-late",
  "legacy-requirements-late",
  "legacy-context-late",
  "default-export",
  "effect-import",
  "sdk-import",
  "legacy-requirements",
  "legacy-context",
  "global-fetch",
  "mutation-approval",
  "module",
  "framework-range",
  "framework-host",
  "source-count",
  "source-size",
  "source-utf8",
  "public-count",
  "public-file-size",
  "public-total-size",
];

function inject(name) {
  let source = valid;
  const manifest = { type: "module", dependencies: { apps: hostVersion(root) } };
  const put = (path, content) => writeFileSync(join(directory, path), content);
  const sparse = (path, size) => {
    const descriptor = openSync(join(directory, path), "w");
    try {
      ftruncateSync(descriptor, size);
    } finally {
      closeSync(descriptor);
    }
  };
  switch (name) {
    case "global-alias":
      source = "const host = globalThis;\n" + valid.replace("ctx.fetch(", "host.fetch(");
      break;
    case "mutation-reexport":
      put(
        "authoring.ts",
        "import { mutation } from 'apps'; export const marker = 1, write = mutation;\n",
      );
      source =
        "import { write as mutation } from './authoring.js';\n" +
        valid
          .replace("defineApp, mutation, object", "defineApp, object")
          .replace(", approval: undefined", "");
      break;
    case "mutation-late":
      source = valid
        .replace("const update = mutation(", "let write; write = mutation;\nconst update = write(")
        .replace(", approval: undefined", "");
      break;
    case "legacy-requirements-late":
      source = valid.replace(
        "export default defineApp({},",
        "let requirements; requirements = { accounts: {} };\nexport default defineApp(requirements,",
      );
      break;
    case "legacy-context-late":
      source = valid.replace(
        "ctx.fetch('https://example.com')",
        "(() => { let old; old = ctx; return old.accounts; })()",
      );
      break;
    case "default-export":
      source = valid.replace("export default defineApp", "const app = defineApp");
      break;
    case "effect-import":
      source = `import { Effect } from 'effect';\n${valid}`;
      break;
    case "sdk-import":
      source = `import { sdk } from '@executor-js/sdk';\n${valid}`;
      break;
    case "legacy-requirements":
      source = valid.replace("defineApp({},", "defineApp({ accounts: {} },");
      break;
    case "legacy-context":
      source = valid.replace("ctx.fetch('https://example.com')", "ctx.accounts");
      break;
    case "global-fetch":
      source = valid.replace("ctx.fetch(", "fetch(");
      break;
    case "mutation-approval":
      source = valid.replace(", approval: undefined", "");
      break;
    case "module":
      delete manifest.type;
      break;
    case "framework-range":
      manifest.dependencies.apps = "^0.0.1-beta.104";
      break;
    case "framework-host":
      manifest.dependencies.apps = "0.0.1-beta.1";
      break;
    case "source-count":
      for (let index = 0; index < limits.sourceFiles; index++) put(`${index}.txt`, "");
      break;
    case "source-size":
      put("large.txt", "x".repeat(limits.sourceBytes + 1));
      break;
    case "source-utf8":
      put("binary.bin", Buffer.from([255, 0]));
      break;
    case "public-count":
      for (let index = 0; index <= limits.publicFiles; index++) put(`ui/public/${index}.bin`, "");
      break;
    case "public-file-size":
      sparse("ui/public/large.bin", limits.publicFileBytes + 1);
      break;
    case "public-total-size":
      for (let index = 0; index < 32; index++)
        sparse(`ui/public/${index}.bin`, limits.publicFileBytes);
      break;
  }
  put("index.ts", source);
  put("package.json", JSON.stringify(manifest));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!cases.includes(name)) throw new Error(`Choose a proof case: ${cases.join(", ")}`);
  if (existsSync(directory)) throw new Error("Refusing to overwrite an existing proof app");
  try {
    mkdirSync(join(directory, "ui/public"), { recursive: true });
    inject(name);
    const result = spawnSync(process.execPath, [join(root, "scripts/app-lint/check.mjs")], {
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
