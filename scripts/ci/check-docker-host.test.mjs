import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = new URL("./check-docker-host.mjs", import.meta.url).pathname;

// A `docker` on PATH that answers like the real CLI for the probe's commands: network and rm
// succeed; `run` either fetches the host listener's URL (its last argument) and prints the body,
// as the container does, or refuses, or never answers.
const docker = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(0);
const mode = process.env.PROBE_RUN;
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "refuse") {
  process.stderr.write("urllib.error.URLError: <urlopen error [Errno 111] Connection refused>\\n");
  process.exit(1);
} else {
  const url = new URL(args.at(-1));
  url.hostname = "127.0.0.1";
  fetch(url).then((response) => response.text()).then((body) => console.log(body));
}
`;

const probe = async (mode, limitSeconds) => {
  const bin = mkdtempSync(join(tmpdir(), "docker-host-probe-"));
  try {
    writeFileSync(join(bin, "docker"), docker);
    chmodSync(join(bin, "docker"), 0o755);
    return await execute(
      process.execPath,
      [script, "fixture:image", ...(limitSeconds ? [String(limitSeconds)] : [])],
      {
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PROBE_RUN: mode },
      },
    ).then(
      ({ stdout }) => ({ ok: true, output: stdout }),
      (error) => ({ ok: false, output: `${error.stdout}${error.stderr}` }),
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

test("a container that answers passes on both bridges", async () => {
  const result = await probe("answer");
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /passed on docker0/u);
  assert.match(result.output, /passed on (the )?private Docker bridge/u);
});

test("a probe that runs out of time says it timed out before the container answered", async () => {
  const result = await probe("hang", 1);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /The probe on docker0 timed out after 1 s before the container answered; nothing says the host listener was unreachable/u,
  );
});

test("a container that ran and could not reach the host fails with what it reported", async () => {
  const result = await probe("refuse");
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /The probe container on docker0 exited with 1 before answering: .*Connection refused/u,
  );
});
