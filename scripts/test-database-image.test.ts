import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pullTestDatabaseImage } from "./test-database-image.ts";

const image = "mirror.gcr.io/library/postgres:17@sha256:0000";
const quota =
  "error from registry: Quota exceeded for quota metric 'Requests per project in the US multi-region' per minute";
const path = process.env.PATH;
const directories: string[] = [];

afterEach(() => {
  process.env.PATH = path;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A Docker without the image whose first `refusals` pulls fail with `refusal`, counting pulls. */
function docker(refusal: string, refusals: number, present = false) {
  const directory = mkdtempSync(join(tmpdir(), "test-database-image-"));
  directories.push(directory);
  writeFileSync(join(directory, "refusal"), `${refusal}\n`);
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
case "$1" in
  image) exit ${present ? 0 : 1} ;;
  pull)
    echo pull >> "${directory}/pulls"
    if [ "$(grep -c . "${directory}/pulls")" -le ${refusals} ]; then cat "${directory}/refusal" >&2; exit 1; fi
    exit 0 ;;
esac
exit 1
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}:${path}`;
  const pulls = join(directory, "pulls");
  return () =>
    existsSync(pulls) ? readFileSync(pulls, "utf8").split("\n").filter(Boolean).length : 0;
}

test("a pull refused for quota is pulled again and then answers", () => {
  const pulls = docker(quota, 1);
  pullTestDatabaseImage(image, 1);
  assert.equal(pulls(), 2);
});

test("a 429 from Docker Hub is pulled again too", () => {
  const pulls = docker("toomanyrequests: You have reached your pull rate limit", 2);
  pullTestDatabaseImage(image, 1);
  assert.equal(pulls(), 3);
});

for (const refusal of [
  "manifest for mirror.gcr.io/library/postgres@sha256:0000 not found: manifest unknown",
  "filesystem layer verification failed for digest sha256:0000",
])
  test(`another refusal fails at once: ${refusal.slice(-24)}`, () => {
    const pulls = docker(refusal, 5);
    assert.throws(
      () => pullTestDatabaseImage(image, 1),
      (error: Error) => error.message === `docker pull ${image} failed: ${refusal}`,
    );
    assert.equal(pulls(), 1);
  });

test("five quota refusals fail with the tries and the last refusal", () => {
  const pulls = docker(quota, 5);
  assert.throws(
    () => pullTestDatabaseImage(image, 1),
    (error: Error) => error.message === `docker pull ${image} failed after 5 tries: ${quota}`,
  );
  assert.equal(pulls(), 5);
});

test("an image Docker already has is not pulled", () => {
  const pulls = docker(quota, 5, true);
  pullTestDatabaseImage(image, 1);
  assert.equal(pulls(), 0);
});
