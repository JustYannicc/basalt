import { fileURLToPath } from "node:url";
import { checkGitSecrets, gitSecretReport, pushBase } from "./git-secrets.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const head = process.env.HEAD_SHA || undefined;
const findings = checkGitSecrets({
  root,
  base: process.env.BASE_SHA || pushBase(root, head),
  head,
  environment: process.env,
});
if (findings.length) {
  console.error(gitSecretReport(findings));
  process.exitCode = 1;
} else {
  console.log("Git secret and generated-file check passed.");
}
