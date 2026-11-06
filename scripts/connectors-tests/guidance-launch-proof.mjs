import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { withGuidanceBrowser } from "./zendesk-company-guidance.mjs";

const [upstream, directory, browserExecutable] = process.argv.slice(2);
assert.ok(upstream && directory && browserExecutable, "Expected the prepared browser inputs");
const { chromium } = createRequire(join(upstream, "package.json"))("playwright");
const root = await mkdtemp(join(directory, "guidance-launch-"));
const parentTemporary = process.env.TMPDIR;
const longTemporary = join(root, "x".repeat(100), "tmp");
await mkdir(longTemporary, { recursive: true, mode: 0o700 });
let temporary;
const profileDirectory = async (browser) => {
  if (process.platform !== "linux") {
    const owned = (await readdir(directory)).filter((name) => name.startsWith("basalt-browser-"));
    assert.equal(owned.length, 1);
    return join(directory, owned[0]);
  }
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const process = processInfo.find((value) => value.type === "browser");
    assert.ok(process && Number.isSafeInteger(process.id) && process.id > 0);
    const command = await readFile(`/proc/${process.id}/cmdline`, "utf8");
    const profile = command.split("\0").find((value) => value.startsWith("--user-data-dir="));
    assert.ok(profile, "The launched browser must expose its own profile path");
    const socket = await readlink(
      join(profile.slice("--user-data-dir=".length), "SingletonSocket"),
    );
    const match = /^\/tmp\/basalt-browser-[^/]+/.exec(socket);
    assert.ok(match, "Chromium must place its singleton socket in the short owned directory");
    return match[0];
  } finally {
    await session.detach();
  }
};
try {
  process.env.TMPDIR = longTemporary;
  if (process.platform === "linux") {
    let direct;
    try {
      await assert.rejects(async () => {
        direct = await chromium.launch({ headless: true, executablePath: browserExecutable });
      }, /SingletonSocket/);
    } finally {
      await direct?.close();
    }
  }
  await withGuidanceBrowser({ chromium, browserExecutable, directory }, async (browser) => {
    temporary = await profileDirectory(browser);
    assert.notEqual(temporary, longTemporary);
    if (process.platform === "linux") {
      assert.ok(temporary.startsWith("/tmp/basalt-browser-"));
      assert.ok(temporary.length < 50);
    }
    const page = await browser.newPage();
    await page.setContent("<p>Guidance browser ready</p>");
    assert.equal(await page.locator("p").innerText(), "Guidance browser ready");
  });
  await assert.rejects(access(temporary), { code: "ENOENT" });
  const failure = new Error("Synthetic guidance callback failure");
  await assert.rejects(
    withGuidanceBrowser({ chromium, browserExecutable, directory }, async (browser) => {
      temporary = await profileDirectory(browser);
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(access(temporary), { code: "ENOENT" });
  console.log(
    JSON.stringify({
      checks: 3,
      longParentTemporary: true,
      linuxLongLaunchRefused: process.platform === "linux",
      helperLaunchPassed: true,
      temporaryRemovedAfterSuccessAndFailure: true,
    }),
  );
} finally {
  if (parentTemporary === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = parentTemporary;
  await rm(root, { recursive: true, force: true });
}
