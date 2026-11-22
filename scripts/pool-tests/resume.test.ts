import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

// #1642 contract (v1) limits the real image runs with.
const resumeIdleMs = 30_000;

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
  const parts: Uint8Array[] = [];
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    text += new TextDecoder().decode(value);
  }
  return Buffer.concat(parts);
}

async function resumeAdvertised(fixture: SharingFixture, expected: boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await fixture.ready();
    if ((ready.body.resume === "v1") === expected) return ready.body;
    await delay(250);
  }
  assert.fail(`/ready never ${expected ? "named" : "dropped"} resume`);
}

test("real image: a cut model stream resumes from its offset, idle buffers go, and a layer crash ends nothing", { timeout: 300_000 }, async () => {
  const fixture = new SharingFixture({ resourcePrefix: "basalt-resume" });
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    const credential = providers.find((row) => row.name === "fixture-p1")!.keys[0]!;
    await new PoolHome(client, "pool-a").add([credential.id]);
    const { key } = await new ComputerHome(client).mint("fixture-member", "pool-a", "resume-computer");
    const ready = await resumeAdvertised(fixture, true);
    const boot = String(ready.boot_id);

    // A marked stream through the layer: read its first event, cut the reader, let the upstream finish.
    const id = randomUUID();
    const marked = { origin: fixture.resume, headers: { "X-Basalt-Resumable": "1", "X-Basalt-Request-Id": id } };
    const first = await fixture.model(key, "resume-session", true, "fixture-model", marked);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("X-Basalt-Resume"), "v1");
    const reader = first.body!.getReader();
    const delivered = await readUntil(reader, "P1");
    await reader.cancel();
    fixture.finishStream();
    await delay(2_000);
    const resumed = await fetch(`${fixture.resume}/__basalt/resume/v1/${id}`, {
      headers: { "X-Basalt-Resume-From": String(delivered.length), "X-Basalt-Resume-Boot": boot },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers.get("X-Basalt-Resume-From"), String(delivered.length));
    assert.match(resumed.headers.get("Content-Type") ?? "", /text\/event-stream/);
    const whole = Buffer.concat([delivered, Buffer.from(await resumed.arrayBuffer())]).toString("utf8");
    const contents = [...whole.matchAll(/"content":"([^"]*)"/g)].map((match) => match[1]);
    assert.deepEqual(contents.filter((content) => content !== ""), ["P1", " slow", " stream", " complete"]);
    assert.match(whole, /data: \[DONE\]\n\n$/);

    // Another boot, an offset past the answer, and an unknown id are gone.
    for (const [from, bootName, which] of [[delivered.length, "another-boot", id], [whole.length + 1, boot, id], [0, boot, randomUUID()]] as const) {
      const gone = await fetch(`${fixture.resume}/__basalt/resume/v1/${which}`, {
        headers: { "X-Basalt-Resume-From": String(from), "X-Basalt-Resume-Boot": bootName },
      });
      assert.equal(gone.status, 410);
      assert.equal(gone.headers.get("X-Basalt-Resume-State"), "gone");
    }

    // After the idle limit with nobody reading, the buffer is gone.
    await delay(resumeIdleMs + 3_000);
    const expired = await fetch(`${fixture.resume}/__basalt/resume/v1/${id}`, {
      headers: { "X-Basalt-Resume-From": String(delivered.length), "X-Basalt-Resume-Boot": boot },
    });
    assert.equal(expired.status, 410);

    // A layer crash withdraws resume and restarts the layer alone; the node keeps serving meanwhile.
    fixture.killResumeLayer();
    await resumeAdvertised(fixture, false, 10_000);
    const direct = await fixture.model(key, "while-layer-down");
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /"content":"P1"/);
    await resumeAdvertised(fixture, true, 60_000);
    assert.equal((await fixture.ready()).body.boot_id, boot, "the container kept its boot");
  } finally {
    await fixture.close();
  }
});
