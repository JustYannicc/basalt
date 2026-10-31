import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";

/** A separate paused TCP consumer avoids fetch's eager body buffering. */
export async function nativeSlowReader(origin, headers, worker, independentCall) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { request } from 'node:http';
    import { createHash } from 'node:crypto';
    const req = request(process.env.READER_URL, {
      method: 'POST', headers: JSON.parse(process.env.READER_HEADERS),
    }, (response) => {
      response.pause();
      const hash = createHash('sha256');
      let bytes = 0;
      process.once('message', () => response.resume());
      response.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
      response.once('end', () => {
        process.send({ bytes, hash: hash.digest('hex') }, () => process.disconnect());
      });
      response.once('error', error => { console.error(error.message); process.exitCode = 1; process.disconnect(); });
      process.send({ paused: true, status: response.statusCode });
    });
    req.once('error', error => { console.error(error.message); process.exitCode = 1; process.disconnect(); });
    req.end(JSON.stringify({ model: 'synthetic-model', stream: true, mode: 'slow' }));
  `,
    ],
    {
      env: {
        ...process.env,
        READER_URL: `${origin}/v1/responses`,
        READER_HEADERS: JSON.stringify(headers),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const exited = once(child, "exit");
  const message = () =>
    Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(30000) }).then(([value]) => value),
      exited.then(([code]) => {
        throw new Error(`Reader exited ${code}: ${diagnostics}`);
      }),
    ]);
  try {
    const paused = await message();
    assert.equal(paused.status, 200);
    assert.equal(paused.paused, true);
    await independentCall();
    const progress = worker.progress();
    assert.equal(progress.blocked, true, "The external producer must be waiting for drain.");
    assert.ok(
      progress.bytes < progress.total,
      "The paused native consumer must stop upstream production.",
    );
    const completed = message();
    child.send("resume");
    const output = await completed;
    const expected = createHash("sha256").update("data: first\n\n");
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let bytes = 0; bytes < progress.total; bytes += chunk.length) expected.update(chunk);
    assert.equal(output.bytes, progress.total + Buffer.byteLength("data: first\n\n"));
    assert.equal(output.hash, expected.digest("hex"));
    assert.equal((await exited)[0], 0, diagnostics);
    return {
      externalProducerBlockedWhilePaused: true,
      upstreamBytesWhilePaused: progress.bytes,
      responseBytes: output.bytes,
      sha256: output.hash,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  }
}
