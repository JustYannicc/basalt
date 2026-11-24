import { spawnSync } from "node:child_process";

// A registry refusing a pull for its rate or quota usually answers again within that window (the
// mirror counts requests per minute). Any other refusal, such as a missing image or a digest that
// fails verification, does not get better by waiting.
const rateRefusal =
  /\b429\b|too many requests|toomanyrequests|rate.?limit|quota exceeded|resource.?exhausted/i;

/**
 * Pull a test database image before `docker run` starts it, so one rate or quota refusal does not
 * fail the test: such a refusal is pulled again after 5, 10, 20 and 40 s, five tries in all, each
 * wait varied by up to a fifth so jobs refused together spread out. Any other refusal, and a pull
 * that hangs for a minute, fails at once. An image Docker already has is not pulled again.
 */
export function pullTestDatabaseImage(image: string, firstWaitMs = 5_000, tries = 5): void {
  if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0) return;
  for (let attempt = 1; ; attempt++) {
    const pull = spawnSync("docker", ["pull", "--quiet", image], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (pull.status === 0) return;
    const refusal =
      [pull.stderr, pull.stdout]
        .map((text) => text?.trim())
        .filter(Boolean)
        .join("\n") || String(pull.error ?? "no Docker diagnostic");
    if (attempt >= tries || !rateRefusal.test(refusal))
      throw new Error(
        `docker pull ${image} failed${attempt > 1 ? ` after ${attempt} tries` : ""}: ${refusal}`,
      );
    const waitMs = firstWaitMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(waitMs));
  }
}
