import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest } from "./manifest.mjs";
import { directoryFiles, discoverApps } from "./source.mjs";
import { hostVersion } from "./host.mjs";
import { lintApp } from "./lint.mjs";

export function checkApps(apps, version) {
  return apps.flatMap((app) => {
    const errors = checkManifest(app.files, version);
    // Invalid paths or source cannot safely become lint input.
    if (!errors.some((error) => /^(source-path|source-utf8):/.test(error)))
      errors.push(...lintApp(app.files));
    return errors.map((error) => `${app.name}: ${error}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--app"))
      throw new Error("Usage: check.mjs [--app directory]");
    const apps = args.length
      ? [{ name: args[1], files: directoryFiles(resolve(args[1])) }]
      : discoverApps(root);
    const errors = checkApps(apps, hostVersion(root));
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log(`App conventions passed for ${apps.length} app source sets.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
