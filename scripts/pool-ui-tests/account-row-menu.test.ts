import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { launchBrowser } from "../../.upstream/e2e/support/browser-launch.ts";

type Page = Awaited<ReturnType<Effect.Success<ReturnType<typeof launchBrowser>>["newPage"]>>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const upstream = join(root, ".upstream");
const require = createRequire(join(upstream, "package.json"));
const { build } =
  require("esbuild") as typeof import("../../.upstream/node_modules/esbuild/lib/main.js");

// The dashboard's own stylesheet, compiled with the Tailwind its build uses: the menu's offset and
// opening animation decide what lies under the pointer when a click opens it.
const tailwind = dirname(
  realpathSync(join(upstream, "apps/hosted/web/node_modules/@tailwindcss/vite")),
);
const stylesheet = (async () => {
  const { compile } = await import(pathToFileURL(join(tailwind, "node/dist/index.mjs")).href);
  const { Scanner } = require(join(tailwind, "oxide"));
  const styles = join(upstream, "packages/ui/src/implementation/styles");
  const compiler = await compile(readFileSync(join(styles, "globals.css"), "utf8"), {
    base: styles,
    onDependency: () => {},
  });
  const sources = [{ base: join(upstream, "packages/ui/src"), pattern: "**/*", negated: false }];
  return compiler.build(new Scanner({ sources }).scan()) as string;
})();

// Two account rows with the host's linked-account menu. Each row's usage registers with the row the
// way the usage band does once its data lands, which adds the menu's Details item and a line under
// the row; `window.setReady` lands or removes it. The page records where each press, release and
// click went.
const fixture = `
import { createRoot } from "react-dom/client";
import { useLayoutEffect, useState } from "react";
import { RegistryProvider } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import { AccountRowProvider, AccountRowMenu, AccountRowDetails, useAccountRow } from "./src/implementation/dashboard/account-row.tsx";
import { LinkedAccountMenu } from "./src/implementation/dashboard/app-accounts.tsx";
import { DropdownMenuItem } from "./src/implementation/components/dropdown-menu.tsx";
const unlink = Atom.fn(() => Effect.void);
function Usage({ ready }) {
  const setUsage = useAccountRow()?.setUsage;
  useLayoutEffect(() => {
    if (ready) setUsage?.({ pending: false });
    return () => setUsage?.(undefined);
  }, [ready, setUsage]);
  return ready ? <p style={{ margin: 0, height: "11.9px", lineHeight: "11.9px", overflow: "hidden" }}>1 req</p> : null;
}
function Row({ name, ready }) {
  return (
    <AccountRowProvider>
      <li style={{ listStyle: "none", padding: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "min(600px, 100%)" }}>
          <span>{name}</span>
          <AccountRowMenu>
            <LinkedAccountMenu label={name} unlink={unlink} Failure={() => null}>
              <DropdownMenuItem asChild>
                <a href="#reconnect" onClick={(event) => { if (!event.defaultPrevented) { event.preventDefault(); window.CHOSEN.push(name + ": Reconnect"); } }}>Reconnect</a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.CHOSEN.push(name + ": Edit details")}>Edit details</DropdownMenuItem>
            </LinkedAccountMenu>
          </AccountRowMenu>
        </div>
        <Usage ready={ready} />
        <AccountRowDetails inline={false}><p data-details={name}>Checks for {name}</p></AccountRowDetails>
      </li>
    </AccountRowProvider>
  );
}
function Fixture() {
  const [ready, setReady] = useState(window.READY === true);
  window.setReady = setReady;
  return <ul style={{ margin: 0, padding: 0 }}><Row name="Backup" ready={ready} /><Row name="Team" ready={ready} /></ul>;
}
window.CHOSEN = [];
window.EVENTS = [];
for (const type of ["pointerdown", "pointerup", "click"])
  document.addEventListener(type, (event) => {
    const target = event.target instanceof Element ? event.target : null;
    window.EVENTS.push(type + ":" + (target?.closest("[role=menuitem]") ? "menuitem" : target?.closest("[data-slot=dropdown-menu-trigger]") ? "trigger" : "other"));
  }, true);
createRoot(document.getElementById("root")).render(<RegistryProvider><Fixture /></RegistryProvider>);`;

const viewports = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };

const withPage = (
  viewport: (typeof viewports)[keyof typeof viewports],
  ready: boolean,
  run: (page: Page) => Promise<void>,
  touch = false,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(launchBrowser({ headless: true, slowMo: 0 }), (browser) =>
        Effect.promise(async () => {
          const scratch = await mkdtemp(join(tmpdir(), "basalt-row-menu-"));
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
            const page = await browser.newPage({ viewport, hasTouch: touch });
            await page.setContent('<div id="root"></div>');
            await page.addStyleTag({ content: await stylesheet });
            await page.evaluate((value) => {
              (window as unknown as { READY: boolean }).READY = value;
            }, ready);
            await page.addScriptTag({ path: bundle, type: "module" });
            await page.getByRole("button", { name: "Manage Team" }).waitFor();
            await run(page);
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

const read = <A>(page: Page, name: "CHOSEN" | "EVENTS") =>
  page.evaluate((key) => (window as unknown as Record<string, A>)[key], name);

/** What the person sees once the menu's own animation has run: whether it is open, which Details. */
const settled = async (page: Page) => {
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            (animation.effect as KeyframeEffect | null)?.target?.closest?.(
              "[data-slot=dropdown-menu-content]",
            ),
        ),
  );
  return {
    menu: await page.getByRole("menu").count(),
    details: await page
      .locator("[data-details]")
      .evaluateAll((elements: Element[]) =>
        elements.map((element) => element.getAttribute("data-details")),
      ),
  };
};

/** The opening press landed on the button and its release on the item that slid under it. */
const releasedOverItem = async (page: Page, release: "pointerup" | "click") => {
  const events = await read<string[]>(page, "EVENTS");
  assert.equal(events[0], "pointerdown:trigger", events.join(" "));
  assert.ok(
    events.includes(`${release}:menuitem`),
    `the release reached an item: ${events.join(" ")}`,
  );
};

for (const [width, viewport] of Object.entries(viewports))
  test(`one click on the bottom edge of a row's menu button only opens the menu (${width})`, async () => {
    // The opening menu's first item slides under a pointer resting on the button's lowest pixel.
    for (const offset of [0.05, 0.1])
      await withPage(viewport, true, async (page) => {
        const box = (await page.getByRole("button", { name: "Manage Team" }).boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height - offset);
        await releasedOverItem(page, "pointerup");
        assert.deepEqual(await settled(page), { menu: 1, details: [] }, `offset ${offset}`);
      });
  });

test("a click aimed at a button that moved up as the row above lost its usage line only opens the menu", () =>
  // As on the Accounts tab: the pointer goes where the button was, and the row above shrinks
  // first, which leaves the pointer just inside the button's bottom edge.
  withPage(viewports.desktop, true, async (page) => {
    const box = (await page.getByRole("button", { name: "Manage Team" }).boundingBox())!;
    await page.evaluate(() =>
      (window as unknown as { setReady(ready: boolean): void }).setReady(false),
    );
    const moved = (await page.getByRole("button", { name: "Manage Team" }).boundingBox())!;
    assert.ok(moved.y < box.y, "the button moved up");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await releasedOverItem(page, "pointerup");
    assert.deepEqual(await settled(page), { menu: 1, details: [] });
  }));

test("a press that drifts a few pixels onto the open menu's first item still only opens the menu", () =>
  withPage(viewports.desktop, true, async (page) => {
    const box = (await page.getByRole("button", { name: "Manage Team" }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 0.1);
    await page.mouse.down();
    await settled(page);
    // The first item starts 9 px below the button once open; 9.5 px is still the same press.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 9.4);
    await page.mouse.up();
    await releasedOverItem(page, "pointerup");
    assert.deepEqual(await settled(page), { menu: 1, details: [] });
  }));

test("the menu stays open while its row's usage lands under it", () =>
  withPage(viewports.desktop, false, async (page) => {
    await page.getByRole("button", { name: "Manage Team" }).click();
    await page.getByRole("menuitem", { name: "Unlink" }).waitFor();
    await page.evaluate(() =>
      (window as unknown as { setReady(ready: boolean): void }).setReady(true),
    );
    assert.deepEqual(await settled(page), { menu: 1, details: [] });
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
      "Details",
      "Reconnect",
      "Edit details",
      "Unlink",
    ]);
  }));

test("a click on an item, or pressing the button and releasing over an item, still chooses it", () =>
  withPage(viewports.desktop, true, async (page) => {
    const trigger = page.getByRole("button", { name: "Manage Team" });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Edit details" }).click();
    const box = (await trigger.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const item = (await page.getByRole("menuitem", { name: "Edit details" }).boundingBox())!;
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await read<string[]>(page, "CHOSEN"), [
      "Team: Edit details",
      "Team: Edit details",
    ]);
  }));

test("a tap opens the menu without choosing anything, and a tap on an item chooses it (phone)", () =>
  withPage(
    viewports.phone,
    true,
    async (page) => {
      const trigger = page.getByRole("button", { name: "Manage Team" });
      const box = (await trigger.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 0.1);
      await releasedOverItem(page, "click");
      assert.deepEqual(await settled(page), { menu: 1, details: [] });
      await page.keyboard.press("Escape");
      assert.equal((await settled(page)).menu, 0);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      assert.deepEqual(await settled(page), { menu: 1, details: [] });
      const item = (await page.getByRole("menuitem", { name: "Edit details" }).boundingBox())!;
      await page.touchscreen.tap(item.x + item.width / 2, item.y + item.height / 2);
      assert.equal((await settled(page)).menu, 0);
      assert.deepEqual(await read<string[]>(page, "CHOSEN"), ["Team: Edit details"]);
    },
    true,
  ));

test("a tap on the bottom edge does not follow a link that is the menu's first item (phone)", () =>
  // Before its usage lands the row has no Details, so a link item comes first; a link handles its
  // own click before the menu does.
  withPage(
    viewports.phone,
    false,
    async (page) => {
      const box = (await page.getByRole("button", { name: "Manage Team" }).boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 0.1);
      await releasedOverItem(page, "click");
      assert.deepEqual(await settled(page), { menu: 1, details: [] });
      assert.deepEqual(await read<string[]>(page, "CHOSEN"), []);
    },
    true,
  ));

test("the keyboard still opens the menu and chooses an item", () =>
  withPage(viewports.desktop, true, async (page) => {
    await page.getByRole("button", { name: "Manage Team" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Edit details" }).waitFor();
    // Typing an item's first letter moves focus to it.
    await page.keyboard.press("e");
    await page
      .getByRole("menuitem", { name: "Edit details" })
      .and(page.locator(":focus"))
      .waitFor();
    await page.keyboard.press("Enter");
    assert.deepEqual(await read<string[]>(page, "CHOSEN"), ["Team: Edit details"]);
  }));
