import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyConnectorsSource } from "./connectors-source.ts";
import { awsFailureSummary } from "../e2e/aws/diagnostics.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".upstream");
const sourcePath = join(root, "src/catalog/aws/source.json");
const sourceBytes = await readFile(sourcePath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const source = JSON.parse(sourceBytes.toString("utf8")) as {
  package: string;
  files: Array<{ path: string; content: string }>;
};
assert.equal(source.package, "aws");
const provider = source.files.find((file) => file.path === "provider.ts")?.content;
const manifestText = source.files.find((file) => file.path === "package.json")?.content;
assert.ok(provider, "AWS source is missing provider.ts");
assert.ok(manifestText, "AWS source is missing package.json");
assert.equal(
  (provider.match(/https:\/\/aws-mcp\.us-east-1\.api\.aws\/mcp/g) ?? []).length,
  1,
  "AWS source must declare the maintained MCP endpoint exactly once",
);
assert.match(provider, /discover:\s*endpoint/);
assert.match(provider, /resource:\s*endpoint/);
assert.match(provider, /loopbackRedirectUri:\s*"http:\/\/127\.0\.0\.1:43119\/oauth\/callback"/);
assert.match(provider, /scopes:\s*\[\]/);
assert.match(provider, /tokenEndpointAuthMethod:\s*"none"/);
const manifest = JSON.parse(manifestText) as { dependencies?: { apps?: string } };
assert.ok(manifest.dependencies?.apps, "AWS package must pin its apps framework release");

const prepared = verifyConnectorsSource(root);
console.log(
  `Pinned runtime verified (${prepared.commit.slice(0, 7)}, ${prepared.patches.length} carried patches).`,
);
const { chromium } = createRequire(join(upstream, "package.json"))("playwright") as {
  chromium: { executablePath(): string };
};
const browserExecutable = chromium.executablePath();
await access(browserExecutable).catch(() => {
  throw new Error(
    "AWS hosted paste proof needs Playwright Chromium; run bunx playwright install chromium first.",
  );
});

const evidenceRoot = join(root, ".generated/aws-proof");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await chmod(evidenceRoot, 0o700);
const directory = await mkdtemp(join(evidenceRoot, "run-"));
await chmod(directory, 0o700);
const frameworkPath = join(upstream, ".local/basalt-framework/framework.json");
const framework = JSON.parse(await readFile(frameworkPath, "utf8")) as {
  [key: string]: string;
};
const frameworkManifest = JSON.parse(framework["package.json"] ?? "{}") as { version?: string };
assert.equal(
  manifest.dependencies?.apps,
  frameworkManifest.version,
  "AWS source must use the exact built framework release; the proof does not rewrite the manifest",
);
for (const path of [
  ".local/test-runtime/host.json",
  ".local/test-runtime/apps.tgz",
  ".local/test-runtime/npm",
  ".local/basalt-framework/framework.json",
]) {
  await access(join(upstream, path)).catch(() => {
    throw new Error(`AWS proof prerequisite missing: ${path}; prepare the pinned runtime first.`);
  });
}
await writeFile(
  join(directory, "proof-input.json"),
  JSON.stringify(
    {
      upstreamCommit: prepared.commit,
      sourceSha256,
      appsVersion: frameworkManifest.version,
      target: "isolated self-host",
      externalService: "loopback AWS MCP and OAuth fixture",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

if (process.argv.includes("--preflight")) {
  console.log(
    `AWS proof preflight passed (${sourceSha256.slice(0, 12)} source, cached self-host runtime).`,
  );
} else {
  // Chromium's Linux singleton socket must fit in sockaddr_un, regardless of checkout depth.
  const home = await mkdtemp(join(tmpdir(), "aws-proof-"));
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };
  const child = spawn(
    "bun",
    [join(root, "e2e/aws/runtime.mjs"), root, upstream, directory, browserExecutable],
    {
      cwd: upstream,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
  }, 15 * 60_000);
  const forceStop = setTimeout(
    () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    },
    15 * 60_000 + 5000,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await writeFile(
      join(directory, "runtime.json"),
      JSON.stringify({ code, timedOut, stdout, stderr }),
      {
        mode: 0o600,
      },
    );
    if (timedOut || code !== 0) {
      const context = await readFile(join(directory, "failure-context.json"), "utf8")
        .then((text) => JSON.parse(text) as { phase?: unknown; checks?: unknown })
        .catch(() => ({}));
      const summary = awsFailureSummary({ ...context, code, timedOut, stderr });
      await writeFile(join(directory, "failure-summary.json"), JSON.stringify(summary, null, 2), {
        mode: 0o600,
      });
      console.error(`AWS proof failure: ${JSON.stringify(summary)}`);
      throw new Error("AWS proof failed; private diagnostics remain in its run directory.");
    }
    const report = stdout
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find((entry) => entry.upstream === "synthetic AWS MCP and OAuth service only");
    assert.ok(
      report && typeof report.checks === "number" && report.checks > 0,
      "AWS runtime proof did not report completion",
    );
    assert.deepEqual(report.discoveredTools, ["get_caller_identity", "call_aws", "execute_script"]);
    assert.equal(report.oauth && typeof report.oauth === "object", true);
    const oauth = report.oauth as Record<string, unknown>;
    assert.equal(oauth.callbackRefusalStopsDcr, true);
    assert.equal(oauth.publicPkceDcr, true);
    assert.equal(oauth.noOAuthScopeStrings, true);
    assert.equal(oauth.replayRejected, true);
    assert.equal(oauth.crossUserCallbackRejected, true);
    assert.equal(oauth.reconnectPreservedAccount, true);
    assert.equal(oauth.reconnectPreservedLinks, true);
    assert.equal(Array.isArray(report.users) && report.users.length, 2);
    assert.ok(report.hostedPasteUi && typeof report.hostedPasteUi === "object");
    const hostedPasteUi = report.hostedPasteUi as Record<string, unknown>;
    for (const field of [
      "cancelReturnsToForm",
      "invalidPasteRejectedWithoutCompletion",
      "validCallbackPastedThroughHostedForm",
      "newAccountSaved",
      "reconnectPreservedAccountId",
      "reconnectPreservedName",
    ])
      assert.equal(hostedPasteUi[field], true, `Hosted paste UI must prove ${field}`);
    assert.equal(hostedPasteUi.outsideRequests, 0);
    assert.deepEqual(hostedPasteUi.screenshots, [
      "aws-paste-step.png",
      "aws-paste-cancel-return.png",
      "aws-paste-invalid-recoverable.png",
      "aws-paste-completed.png",
      "aws-reconnect-paste-step.png",
      "aws-reconnect-preserved-name.png",
    ]);
    assert.ok(Array.isArray(report.oauthRefreshRotation));
    assert.deepEqual(
      (report.oauthRefreshRotation as Array<{ actor: string }>).map((entry) => entry.actor).sort(),
      ["member", "owner-reconnected"],
    );
    for (const rotation of report.oauthRefreshRotation as Array<{
      actor: string;
      generations: number[];
    }>) {
      assert.ok(
        rotation.generations.length >= 2,
        `${rotation.actor} must prove multiple rotations`,
      );
      assert.deepEqual(
        rotation.generations,
        rotation.generations.map((_, index) => index + 1),
      );
    }
    assert.match(String(report.authorizationCompletion), /full provider callback URL/);
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceStop);
    await rm(home, { recursive: true, force: true });
  }
}
