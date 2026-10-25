import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const roles = [
  ["owner", "zendesk-owner"],
  ["admin", "zendesk-admin"],
  ["member", "zendesk-member"],
];

/** Provision private self-host actors with the pinned upstream testing CLI before its server starts. */
export async function provisionSelfHostActors({ executable, upstream, target, authSecret, directory }) {
  const cli = join(upstream, "apps/hosted/testing/cli.ts");
  const outputDirectory = join(directory, "test-accounts");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? outputDirectory,
    TMPDIR: process.env.TMPDIR ?? outputDirectory,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    NO_COLOR: "1",
    NODE_ENV: "test",
    BETTER_AUTH_URL: target.metadata.origin,
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_DATA_DIR: join(target.directory, "data"),
  };
  let organizationId;
  let organizationSlug;
  const accounts = {};

  for (const [role, name] of roles) {
    const output = join(outputDirectory, `${role}.json`);
    const log = join(outputDirectory, `${role}.log`);
    const child = spawn(executable, [
      cli,
      "--host", "self-host",
      "--name", name,
      "--organization", "zendesk-native",
      "--role", role,
      "--output", output,
    ], {
      cwd: upstream,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) {
      await writeFile(log, JSON.stringify({ code, stdout, stderr }), { mode: 0o600 });
      throw new Error(`Pinned hosted test-account CLI failed for ${role}; private diagnostics retained.`);
    }

    const account = JSON.parse(await readFile(output, "utf8"));
    if (account.origin !== target.metadata.origin || account.role !== role
      || typeof account.userId !== "string" || typeof account.organizationId !== "string"
      || account.organizationSlug !== "zendesk-native" || !Array.isArray(account.cookies)
      || account.cookies.length === 0 || typeof account.headers?.cookie !== "string") {
      throw new Error(`Pinned hosted test-account CLI returned an invalid ${role} session.`);
    }
    if (organizationId !== undefined && account.organizationId !== organizationId)
      throw new Error("Pinned hosted test-account CLI returned different organizations.");
    organizationId = account.organizationId;
    organizationSlug = account.organizationSlug;
    accounts[role] = account;
  }

  return {
    organization: { id: organizationId, slug: organizationSlug },
    owner: accounts.owner,
    admin: accounts.admin,
    member: accounts.member,
  };
}
