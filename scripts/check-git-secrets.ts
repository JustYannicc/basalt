import { fileURLToPath } from "node:url";
import { checkGitSecrets, gitSecretReport } from "./git-secrets.ts";

const findings = checkGitSecrets({
  root: fileURLToPath(new URL("../", import.meta.url)),
  base: process.env.BASE_SHA,
  head: process.env.HEAD_SHA,
  environment: process.env,
});
if (findings.length) {
  console.error(gitSecretReport(findings));
  process.exitCode = 1;
} else {
  console.log("Git secret and generated-file check passed.");
}
