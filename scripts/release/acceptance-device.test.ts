import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { hostAssertionTtlMs, openEnvelope } from "../../src/pool/token.ts";
import {
  acceptanceAssertionTtlMs,
  acceptanceCredential,
  AcceptanceDeviceRefused,
} from "./acceptance-device.ts";
import { failureReport } from "./public-report.ts";

const signingKey = "ab".repeat(32);
const device = {
  computer: "computer-7f3a91",
  grant: "native:grant-c2d4e6",
  user: "person-b81f07",
  pool: "pool-e5a9c3",
};
/** `null` leaves the variable out of the environment. */
const environment = (value: unknown = device, key: string | null = signingKey) => ({
  ...(value === null
    ? {}
    : { POOL_ACCEPTANCE_DEVICE: typeof value === "string" ? value : JSON.stringify(value) }),
  ...(key === null ? {} : { POOL_APP_SIGNING_KEY: key }),
});

test("each model call carries its own device assertion, bound to that call, and no bearer", async () => {
  const seen: Request[] = [];
  const client = new PoolAcceptanceClient({
    origin: "https://pool.example",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      const headers = { "X-Signalbox-Pool-Boot": "boot-a" };
      return new URL(request.url).pathname === "/v1/models"
        ? Response.json({ data: [{ id: "model-a" }] }, { headers })
        : new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
            headers: { ...headers, "content-type": "text/event-stream" },
          });
    },
  });
  // Each read of the clock is one assertion minted; a reused one would repeat an expiry.
  let clock = 1_000_000;
  const credential = acceptanceCredential(environment(), () => clock++);
  await client.modelCatalog(credential);
  await client.sendTurn(credential, "model-a", { id: "conversation-1", expectedRecords: 1 });
  await client.sendTurn(credential, "model-a", { id: "conversation-2", expectedRecords: 1 });

  assert.equal(seen.length, 3);
  const assertions = new Set<string>();
  for (const [index, request] of seen.entries()) {
    assert.equal(request.headers.get("authorization"), null, "no bearer");
    const assertion = request.headers.get(nativeModelHeader);
    assert.ok(assertion, "the device assertion");
    assertions.add(assertion);
    const url = new URL(request.url);
    assert.deepEqual(await openEnvelope(signingKey, nativeModelPrefix, assertion), {
      ...device,
      method: request.method,
      path: url.pathname + url.search,
      expiresAt: 1_000_000 + index + acceptanceAssertionTtlMs,
    });
  }
  assert.equal(assertions.size, 3, "a fresh assertion per request");
  assert.deepEqual(
    seen.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ["GET /v1/models", "POST /v1/chat/completions", "POST /v1/chat/completions"],
  );
});

test("an assertion binds the query too and lives no longer than the edge's own", async () => {
  const credential = acceptanceCredential(environment(), () => 5_000);
  const headers = await credential("GET", "/v1/models?limit=1");
  assert.deepEqual(
    Object.keys(headers),
    [nativeModelHeader],
    "only the assertion, never an Authorization",
  );
  const payload = await openEnvelope(signingKey, nativeModelPrefix, headers[nativeModelHeader]!);
  assert.equal((payload as { path?: unknown }).path, "/v1/models?limit=1");
  assert.ok(acceptanceAssertionTtlMs > 0 && acceptanceAssertionTtlMs <= hostAssertionTtlMs);
});

test("a missing or malformed acceptance identity stops with a public line naming it, never its ids", () => {
  const refusal = (env: NodeJS.ProcessEnv) => {
    try {
      acceptanceCredential(env);
    } catch (error) {
      assert.ok(error instanceof AcceptanceDeviceRefused, String(error));
      return failureReport(error).publicText;
    }
    return assert.fail("accepted a bad acceptance identity");
  };
  for (const [value, why] of [
    [null, /why=unset/u],
    ["", /why=unset/u],
    ["{not json", /why=malformed/u],
    [{ ...device, grant: "grant-c2d4e6" }, /why=malformed/u],
    [{ ...device, computer: "" }, /why=malformed/u],
    [{ user: device.user, pool: device.pool }, /why=malformed/u],
  ] as const) {
    const text = refusal(environment(value));
    assert.match(text, /AcceptanceDeviceRefused: field=POOL_ACCEPTANCE_DEVICE/u, text);
    assert.match(text, why, text);
    assert.match(text, /fix=/u, text);
    for (const id of Object.values(device)) assert.ok(!text.includes(id), `${id} in ${text}`);
  }
  for (const key of [null, "", "abc", "AB".repeat(32)]) {
    const text = refusal(environment(device, key));
    assert.match(text, /field=POOL_APP_SIGNING_KEY /u, text);
    assert.ok(!key || !text.includes(key), "never the key");
  }
  const previous = refusal({ ...environment(), POOL_APP_SIGNING_KEY_PREVIOUS: "abc" });
  assert.match(previous, /field=POOL_APP_SIGNING_KEY_PREVIOUS /u, previous);
});

test("a blank previous key is no key: mid-rotation or not, acceptance signs with the current one", async () => {
  for (const previous of ["", " ", "\n", " \t\n"]) {
    const credential = acceptanceCredential(
      { ...environment(), POOL_APP_SIGNING_KEY_PREVIOUS: previous },
      () => 5_000,
    );
    const headers = await credential("GET", "/v1/models");
    assert.ok(
      await openEnvelope(signingKey, nativeModelPrefix, headers[nativeModelHeader]!),
      JSON.stringify(previous),
    );
  }
});

/** The entry as the release runs it; it exits on its own once the step's command is done. */
async function entry(args: string[], env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./deploy.ts", import.meta.url)), ...args],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, output };
}

test("boot and accept exit 4, never a failure to undo, when the device is misnamed or refused", async () => {
  // A failed run's private detail lands in the repo's own .local/release, as a release's does.
  const kept = ["failure", "acceptance"].map((name) =>
    fileURLToPath(new URL(`../../.local/release/${name}.txt`, import.meta.url)),
  );
  const before = await Promise.all(
    kept.map((file) => readFile(file, "utf8").catch(() => undefined)),
  );
  const cwd = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "acceptance-device-"),
  );
  const seen: { authorization?: string; assertion?: string }[] = [];
  const pool = createServer((request, response) => {
    seen.push({
      authorization: request.headers.authorization,
      assertion: request.headers[nativeModelHeader] as string | undefined,
    });
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"unauthorized","message":"This device is no longer connected."}');
  });
  await new Promise<void>((done) => pool.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(pool.address() as AddressInfo).port}`;
  const stage = ["--stage", "test-acceptance-device"];
  const commands = [
    ["boot", ...stage, "--out", join(cwd, "boot.json"), "--allow-not-serving"],
    ["accept", ...stage, "--expect", "any", "--out", join(cwd, "accept.json")],
  ];
  try {
    for (const args of commands) {
      const misnamed = await entry(args, {
        POOL_ACCEPTANCE_ORIGIN: origin,
        POOL_ACCEPTANCE_DEVICE: JSON.stringify({ computer: device.computer }),
        POOL_APP_SIGNING_KEY: signingKey,
      });
      assert.equal(misnamed.status, 4, misnamed.output);
      assert.match(misnamed.output, /field=POOL_ACCEPTANCE_DEVICE why=malformed/u);
      assert.ok(!misnamed.output.includes(device.computer), misnamed.output);
    }
    assert.equal(seen.length, 0, "a misnamed device sends nothing");
    const env = { POOL_ACCEPTANCE_ORIGIN: origin, ...environment() };
    const boot = await entry(commands[0]!, env);
    assert.equal(boot.status, 4, boot.output);
    assert.match(
      boot.output,
      /why=the pool refused it \(HTTP 401\) fix=the release's acceptance device was refused: check that it is still registered and allowed/u,
    );
    const accept = await entry(commands[1]!, env);
    assert.equal(accept.status, 4, accept.output);
    assert.match(
      accept.output,
      /ACCEPTANCE COULD NOT TEST: the release's acceptance device was refused: check that it is still registered and allowed/u,
    );
    assert.match(await readFile(join(cwd, "accept.json"), "utf8"), /"outcome": "could-not-test"/u);
    assert.equal(seen.length, 2, "one catalog read each");
    for (const { authorization, assertion } of seen) {
      assert.equal(authorization, undefined, "no bearer");
      assert.ok(assertion?.startsWith(`${nativeModelPrefix}.`), "the device assertion");
      for (const output of [boot.output, accept.output]) assert.ok(!output.includes(assertion!));
    }
    for (const id of Object.values(device))
      for (const output of [boot.output, accept.output]) assert.ok(!output.includes(id), id);
  } finally {
    pool.close();
    await rm(cwd, { recursive: true, force: true });
    for (const [index, file] of kept.entries()) {
      if (before[index] === undefined) await rm(file, { force: true });
      else await writeFile(file, before[index]!);
    }
  }
});

test("given this run's boot record, accept reads a refusal as the release's, served before or not", async () => {
  // The rollback's re-accept and a declared restart both run after a boot read the pool did not
  // refuse (a refusal stops the run there), so a 401 there is the version's, never the device's.
  const kept = ["failure", "acceptance"].map((name) =>
    fileURLToPath(new URL(`../../.local/release/${name}.txt`, import.meta.url)),
  );
  const before = await Promise.all(
    kept.map((file) => readFile(file, "utf8").catch(() => undefined)),
  );
  const cwd = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "acceptance-admitted-"),
  );
  const pool = createServer((_, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"unauthorized","message":"This device is no longer connected."}');
  });
  await new Promise<void>((done) => pool.listen(0, "127.0.0.1", done));
  const env = {
    POOL_ACCEPTANCE_ORIGIN: `http://127.0.0.1:${(pool.address() as AddressInfo).port}`,
    ...environment(),
  };
  try {
    for (const boot of ["boot-root", "not-serving"]) {
      await writeFile(join(cwd, "boot.json"), JSON.stringify({ boot }));
      const accept = await entry(
        [
          "accept",
          "--stage",
          "test-acceptance-device",
          "--expect",
          "any",
          "--admitted",
          join(cwd, "boot.json"),
          "--out",
          join(cwd, "accept.json"),
        ],
        env,
      );
      assert.equal(accept.status, 1, `${boot}: ${accept.output}`);
      assert.match(accept.output, /^Acceptance FAILED: .*"failed":1/mu, boot);
      assert.doesNotMatch(
        await readFile(join(cwd, "accept.json"), "utf8"),
        /could-not-test/u,
        boot,
      );
    }
  } finally {
    pool.close();
    await rm(cwd, { recursive: true, force: true });
    for (const [index, file] of kept.entries()) {
      if (before[index] === undefined) await rm(file, { force: true });
      else await writeFile(file, before[index]!);
    }
  }
});
