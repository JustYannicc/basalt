import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { launchBrowser } from "../../.upstream/e2e/support/browser-launch.ts";

type Page = Awaited<ReturnType<Effect.Success<ReturnType<typeof launchBrowser>>["newPage"]>>;

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const require = createRequire(join(upstream, "package.json"));
const { build } =
  require("esbuild") as typeof import("../../.upstream/node_modules/esbuild/lib/main.js");

// The naming prompt as a new connection opens it: the field has focus before the provider is known,
// and `window.arrive` delivers the provider, which writes the account's default name into the field.
// A second field stands for one whose value a key changes, as a suggestion list does.
const fixture = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Exit } from "effect";
import { NameAccountForm, NameAccountModal } from "./src/implementation/dashboard/name-account.tsx";
import { Input } from "./src/implementation/components/input.tsx";
const account = { label: "", method: "oauth", provider: "google", identity: null };
const provider = { id: "google", definition: { name: "Gmail", auth: {} } };
window.SAVED = [];
function Prompt() {
  const [known, setKnown] = useState(false);
  window.arrive = () => setKnown(true);
  return (
    <NameAccountModal handoff={false} busy={false} onClose={() => {}}>
      <NameAccountForm
        account={account}
        provider={known ? provider : undefined}
        update={async (changes) => { window.SAVED.push(changes); return Exit.succeed(undefined); }}
        Failure={() => null}
        identity={{ resolving: false, name: undefined, failed: false }}
        retry={() => {}}
        onDone={() => window.SAVED.push("done")}
      />
    </NameAccountModal>
  );
}
function Suggesting() {
  const [value, setValue] = useState("");
  return (
    <Input
      aria-label="Suggesting"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") setValue("suggested"); }}
    />
  );
}
const prompt = document.getElementById("prompt");
createRoot(prompt).render(window.SHOW === "prompt" ? <Prompt /> : <Suggesting />);
`;

const withPage = (show: "prompt" | "suggesting", run: (page: Page) => Promise<void>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(launchBrowser({ headless: true, slowMo: 0 }), (browser) =>
        Effect.promise(async () => {
          const scratch = await mkdtemp(join(tmpdir(), "basalt-name-default-"));
          try {
            const bundle = join(scratch, "fixture.js");
            await build({
              stdin: {
                contents: fixture,
                loader: "tsx",
                resolveDir: join(upstream, "packages/ui"),
              },
              outfile: bundle,
              bundle: true,
              platform: "browser",
              format: "esm",
              jsx: "automatic",
              define: { "process.env.NODE_ENV": '"production"' },
              logLevel: "silent",
            });
            const page = await browser.newPage();
            await page.setContent('<div id="prompt"></div>');
            await page.evaluate((value) => {
              (window as unknown as { SHOW: string }).SHOW = value;
            }, show);
            await page.addScriptTag({ path: bundle, type: "module" });
            await run(page);
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

const field = (page: Page) => page.getByRole("textbox", { name: "Account name", exact: true });
const focused = (page: Page) =>
  page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") !== null);
// Wait until the field shows `value`, then let the next frame paint before the person types.
const shows = async (page: Page, value: string) => {
  await page.waitForFunction(
    (expected) => document.querySelector("input")?.value === expected,
    value,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
};

test("the default name that arrives in a focused, untouched field is replaced by what the person types", () =>
  withPage("prompt", async (page) => {
    await field(page).waitFor();
    assert.equal(await field(page).evaluate((input) => input === document.activeElement), true);
    assert.equal(await field(page).inputValue(), "");
    await page.evaluate(() => (window as unknown as { arrive: () => void }).arrive());
    await shows(page, "Gmail account");
    // Typed text, inserted where the caret is, with no selection of its own.
    await page.keyboard.insertText("Recovery account");
    assert.equal(await field(page).inputValue(), "Recovery account");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.waitForFunction(() => (window as unknown as { SAVED: unknown[] }).SAVED.length > 1);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { SAVED: unknown[] }).SAVED), [
      { label: "Recovery account" },
      "done",
    ]);
  }));

test("a name the person has started typing is kept when the default arrives", () =>
  withPage("prompt", async (page) => {
    await field(page).waitFor();
    await page.keyboard.insertText("Rec");
    await shows(page, "Rec");
    await page.evaluate(() => (window as unknown as { arrive: () => void }).arrive());
    await page.getByText("Gmail is connected.").waitFor();
    await page.keyboard.insertText("overy account");
    assert.equal(await field(page).inputValue(), "Recovery account");
  }));

test("a value the person's own key put in the field is typed after, not replaced", () =>
  withPage("suggesting", async (page) => {
    const input = page.getByRole("textbox", { name: "Suggesting", exact: true });
    await input.focus();
    await focused(page);
    await page.keyboard.press("Enter");
    await shows(page, "suggested");
    await page.keyboard.insertText("!");
    assert.equal(await input.inputValue(), "suggested!");
  }));
