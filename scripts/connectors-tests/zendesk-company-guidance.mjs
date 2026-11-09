import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import guidanceSnapshot from "./zendesk-company-guidance.snapshot.json" with { type: "json" };

/** Keep Chromium's Linux singleton socket below the Unix socket path limit. */
export async function withGuidanceBrowser({ chromium, browserExecutable, directory }, run) {
  const temporary = await mkdtemp(
    join(process.platform === "linux" ? "/tmp" : directory, "basalt-browser-"),
  );
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable,
      env: { ...process.env, TMPDIR: temporary },
    });
    return await run(browser);
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/** Check the real connect form before authorizing, including the values its copy buttons return. */
export async function proveCompanyGuidance({
  upstream,
  browserExecutable,
  directory,
  origin,
  cookies,
  connection,
  callback,
  fixtures,
}) {
  const require = createRequire(join(upstream, "package.json"));
  const { chromium } = require("playwright");
  const captures = join(directory, "company-guidance");
  await mkdir(captures, { recursive: true });
  return await withGuidanceBrowser({ chromium, browserExecutable, directory }, async (browser) => {
    const observations = [];
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url: origin })));
    const page = await context.newPage();
    fixtures.setTenantCallback("site-a", "http://localhost:27439/callback");
    await page.goto(connection.url);
    const dialog = page.getByRole("dialog", { name: "Connect Zendesk" });
    const picker = dialog.getByRole("combobox", { name: "Sign-in method" });
    await picker.waitFor();
    const choose = async (label) => {
      await picker.click();
      await page.getByRole("option").filter({ hasText: label }).click();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
    };
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      for (const [method, label, expectedCallback] of [
        ["hosted", "Company client (hosted callback)", callback],
        ["paste", "Company client (paste callback)", "http://localhost:27439/callback"],
        ["custom", "Your own Zendesk app (OAuth)", callback],
      ]) {
        await choose(label);
        const box = await dialog.boundingBox();
        const text = await dialog.innerText();
        const callbackCopy = dialog.getByRole("button", {
          name: method === "custom" ? "Copy redirect URL" : "Copy callback URL",
          exact: true,
        });
        const clientCopy = dialog.getByRole("button", { name: "Copy client ID", exact: true });
        const entry = {
          width,
          method,
          label,
          expectedCallback,
          box,
          text,
          callbackCopy: await callbackCopy.count(),
          clientCopy: await clientCopy.count(),
        };
        observations.push(entry);
        await page.screenshot({ path: join(captures, `${method}-${width}.png`) });
        assert.ok(box.x >= 0 && box.x + box.width <= width, "The dialog must fit the viewport");
        if (method === "custom") {
          assert.match(text, /Use an OAuth app in Zendesk that allows this redirect URL/);
          assert.equal(await dialog.getByLabel("Client ID", { exact: true }).count(), 1);
          assert.equal(await dialog.getByLabel("Client secret (optional)").count(), 1);
        }
      }
    }
    await writeFile(join(captures, "observations.json"), JSON.stringify(observations, null, 2));
    for (const entry of observations.filter(({ method }) => method !== "custom")) {
      assert.ok(
        entry.text.includes(guidanceSnapshot.setupInstructions),
        `${entry.method} at ${entry.width}: show the company-owned client setup guidance`,
      );
      assert.match(
        entry.text,
        /Admin Center.*Apps and integrations.*APIs.*OAuth clients/s,
        `${entry.method} at ${entry.width}: show where the Zendesk admin registers the client`,
      );
      assert.match(entry.text, /read and write/);
      assert.equal(
        entry.callbackCopy,
        1,
        `${entry.method} at ${entry.width}: show a copyable callback URL`,
      );
      assert.equal(
        entry.clientCopy,
        1,
        `${entry.method} at ${entry.width}: show a copyable public client ID`,
      );
      assert.ok(entry.text.includes(entry.expectedCallback));
      assert.ok(entry.text.includes("site-a_zendesk"));
    }
    for (const [method, registered] of [
      ["hosted", callback],
      ["paste", "http://localhost:27439/callback"],
    ]) {
      fixtures.setTenantCallback("site-a", registered);
      await page.reload();
      await picker.waitFor();
      await choose(`Company client (${method === "hosted" ? "hosted" : "paste"} callback)`);
      assert.equal(
        await dialog.getByRole("button", { name: "Connect Zendesk", exact: true }).isEnabled(),
        true,
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        await page.screenshot({ path: join(captures, `${method}-ready-${width}.png`) });
        for (const [name, value] of [
          ["Copy callback URL", registered],
          ["Copy client ID", "site-a_zendesk"],
        ]) {
          const button = dialog.getByRole("button", { name, exact: true });
          await button.click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value);
          const box = await button.boundingBox();
          assert.ok(
            box.x >= 0 && box.x + box.width <= width,
            "Copy controls must fit the viewport",
          );
          if (width === 390)
            assert.ok(
              box.width >= 44 && box.height >= 44,
              "Copy controls must be touch-sized at 390",
            );
        }
      }
    }
    assert.equal(
      fixtures.observations().filter(({ phase }) => phase === "token_exchange").length,
      0,
      "Inspecting setup and copying values must never authorize an account",
    );
    return {
      widths: [1280, 390],
      methods: 3,
      captures: 10,
      exactClipboardValues: true,
      authorizationStarted: false,
    };
  });
}
