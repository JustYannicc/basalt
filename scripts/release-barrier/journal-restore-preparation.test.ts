import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAdoptionProof } from "./journal-restore-proof.ts";
import { observationStoreEnvelope } from "./observation-store-envelope.ts";
import { restorePreparationFixture } from "./test/restore-preparation-fixture.ts";

test("restore preparation consumes a real HTTP 302 under the global envelope without forwarding credentials or following other redirects", async () => {
  const f = await restorePreparationFixture();
  try {
    const envelope = observationStoreEnvelope(
      f.adoption.accountId,
      async () => {
        assert.fail("Preparation attempted Cloudflare auth");
      },
      f.transport,
    );
    const proof = await loadAdoptionProof(f.source, f.adoption, f.env, envelope.fetch);
    assert.deepEqual(proof.receipt, f.receipt.receipt);
    assert.equal(f.requests.length, 4);
    assert.equal(f.requests[2]!.authorization, "Bearer synthetic-repository-token");
    assert.equal(f.requests[3]!.authorization, undefined);
    await assert.rejects(
      envelope.fetch("https://archive.example.test/unexpected-redirect"),
      TypeError,
    );
    assert.ok(!f.requests.some((request) => request.path === "/escaped"));
    assert.deepEqual(envelope.receipt().authPreviewRequests, {
      createSubdomainEdgePreviewSession: 0,
      createScriptEdgePreview: 0,
    });
    assert.equal(envelope.receipt().otherCloudflareMutations, 0);
    assert.equal(envelope.receipt().blockedMutations, 0);
  } finally {
    await f.close();
  }
});

for (const command of [process.execPath, "bun"])
  test(`the actual restore PLAN entry reaches the denied Cloudflare boundary after verified GitHub preparation (${command === "bun" ? "Bun" : "Node"})`, async () => {
    const f = await restorePreparationFixture();
    try {
      const preload = join(f.directory, "transport.mjs");
      await writeFile(
        preload,
        `
        import { writeFileSync } from "node:fs";
        const nativeFetch=globalThis.fetch;
        globalThis.fetch=async(input,init)=>{
          const request=new Request(input,init),url=new URL(request.url);
          if(url.hostname==='api.cloudflare.com') { writeFileSync(process.env.RESTORE_FIXTURE_MARKER,JSON.stringify({method:request.method,host:url.hostname,path:url.pathname})); process.exit(23); }
          if(!['api.github.com','archive.example.test'].includes(url.hostname)) throw new Error('REAL NETWORK DENIED');
          return nativeFetch(new Request(process.env.RESTORE_FIXTURE_ORIGIN+url.pathname+url.search,request));
        };
      `,
      );
      const child = spawn(
        command,
        [
          command === "bun" ? "--preload" : "--import",
          preload,
          fileURLToPath(new URL("./provisioning-entry.ts", import.meta.url)),
        ],
        {
          env: {
            PATH: process.env.PATH,
            ...f.env,
            RESTORE_FIXTURE_ORIGIN: f.origin,
            RESTORE_FIXTURE_MARKER: join(f.directory, "state-boundary.json"),
            GITHUB_ACTIONS: "true",
            GITHUB_REF: "refs/heads/main",
            GITHUB_WORKFLOW_REF:
              "synthetic/basalt/.github/workflows/pool-runtime-provision.yml@refs/heads/main",
            GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "789",
            GITHUB_RUN_ATTEMPT: "1",
            CLOUDFLARE_ACCOUNT_ID: f.adoption.accountId,
            CLOUDFLARE_API_TOKEN: "synthetic-deployer-token",
            ALCHEMY_STAGE: "production",
            EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
            POOL_DEPLOYMENT_KEY: "c".repeat(64),
            POOL_PROVISIONING_MODE: "plan",
            POOL_PROVISIONING_PACKET: JSON.stringify(f.packet),
            POOL_PROVISIONING_OUTPUT_DIRECTORY: join(f.directory, "output"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 23, output);
      assert.equal(f.requests.length, 4, output);
      assert.equal(f.requests.at(-1)!.authorization, undefined);
      const boundary = JSON.parse(await readFile(join(f.directory, "state-boundary.json"), "utf8"));
      assert.equal(boundary.method, "GET");
      assert.equal(boundary.host, "api.cloudflare.com");
      assert.doesNotMatch(output, /synthetic-repository-token|synthetic-deployer-token/);
    } finally {
      await f.close();
    }
  });

test("the CI preparation probe verifies the same archive through real fetch and records zero State or Cloudflare calls", async () => {
  const f = await restorePreparationFixture();
  try {
    const { probeRestorePreparation } = await import("./restore-preparation-probe.ts");
    const result = await probeRestorePreparation(
      {
        ...f.env,
        BASALT_RESTORE_PREPARATION_PROBE_INPUT: JSON.stringify({
          source: f.source,
          adoption: f.adoption,
        }),
        BASALT_RESTORE_PREPARATION_PROBE_OUTPUT: join(f.directory, "probe.json"),
      },
      f.transport,
    );
    assert.equal(result.preparation, "PASS");
    assert.deepEqual(result.calls, { github: 3, archive: 1, cloudflare: 0, stateOrOther: 0 });
    assert.equal(result.networkEnvelope.authPreviewPosts, 0);
    assert.equal(result.networkEnvelope.blockedMutations, 0);
    assert.equal(f.requests.at(-1)!.authorization, undefined);
  } finally {
    await f.close();
  }
});

test("a missing CI source-run pin fails preparation before any GitHub, State or Cloudflare request", async () => {
  const f = await restorePreparationFixture();
  try {
    const { probeRestorePreparation } = await import("./restore-preparation-probe.ts");
    await assert.rejects(
      probeRestorePreparation(
        {
          ...f.env,
          POOL_OBSERVATION_STORE_RESTORE_RUN_ID: "",
          BASALT_RESTORE_PREPARATION_PROBE_INPUT: JSON.stringify({
            source: f.source,
            adoption: f.adoption,
          }),
          BASALT_RESTORE_PREPARATION_PROBE_OUTPUT: join(f.directory, "probe.json"),
        },
        f.transport,
      ),
      /journal-restore-run-not-approved/,
    );
    assert.equal(f.requests.length, 0);
    const result = JSON.parse(await readFile(join(f.directory, "probe.json"), "utf8"));
    assert.equal(result.preparation, "FAIL");
    assert.deepEqual(result.calls, { github: 0, archive: 0, cloudflare: 0, stateOrOther: 0 });
  } finally {
    await f.close();
  }
});
