// The vault page's note renderer, rendered for real: the app's own ui/ sources bundled with the
// packages the app declares (installed here at the same pins), mounted in a virtual DOM, with
// effects and image loads allowed to finish.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const here = fileURLToPath(new URL("./", import.meta.url));
const app = fileURLToPath(new URL("../../../apps/obsidian/", import.meta.url));
const packages = join(here, "node_modules");
// Renderer packages the app serves; this package must install exactly these.
const rendered = [
  "react",
  "react-dom",
  "react-markdown",
  "remark-gfm",
  "@flowershow/remark-wiki-link",
  "@r4ai/remark-callout",
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
let ui;
let scratch;

before(async () => {
  if (!existsSync(packages))
    throw new Error(
      "Install the vault page's renderer packages first: bun install --cwd e2e/obsidian/vault-page --frozen-lockfile",
    );
  scratch = mkdtempSync(join(tmpdir(), "obsidian-vault-page-"));
  const result = await build({
    stdin: {
      contents: [
        'export { NoteMarkdown } from "./note-markdown.tsx";',
        'export { act, createElement } from "react";',
        'export { createRoot } from "react-dom/client";',
      ].join("\n"),
      resolveDir: join(app, "ui"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    // The conditions the app compiler resolves packages with.
    conditions: ["import", "browser"],
    jsx: "automatic",
    nodePaths: [packages],
    metafile: true,
    logLevel: "silent",
  });
  // Every package in the bundle came from this pinned install, never from elsewhere in the repo.
  const strays = Object.keys(result.metafile.inputs).filter(
    (input) => input.includes("node_modules/") && !join(process.cwd(), input).startsWith(packages),
  );
  assert.deepEqual(strays, []);
  const bundle = join(scratch, "note-markdown.mjs");
  writeFileSync(bundle, result.outputFiles[0].text);
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ui = await import(pathToFileURL(bundle).href);
});

after(async () => {
  await GlobalRegistrator.unregister();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const files = [
  "Projects/Seed order.md",
  "Reference/Volunteer rota.md",
  "Attachments/lot-sketch.png",
];

/** Mount a note, let effects and image reads settle, and return its container. */
async function mount(content, { loadFile = async () => null, onOpen = () => {} } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ui.createRoot(container);
  await ui.act(async () => {
    root.render(ui.createElement(ui.NoteMarkdown, { content, files, onOpen, loadFile }));
  });
  // Image reads resolve on later turns; flush until nothing is still loading.
  for (let turn = 0; turn < 20 && container.querySelector(".embed-loading"); turn++)
    await ui.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return { container, unmount: () => ui.act(() => root.unmount()) };
}

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

test("the test package installs the renderer exactly as the app declares and serves it", () => {
  const declared = readJson(join(app, "package.json")).dependencies;
  const pinned = readJson(join(here, "package.json")).dependencies;
  for (const name of rendered) {
    assert.equal(pinned[name], declared[name], `${name} pin differs from apps/obsidian`);
    assert.equal(readJson(join(packages, name, "package.json")).version, declared[name], name);
  }
});

test("wikilinks resolve by Obsidian's shortest path, keep aliases, and leave missing notes inert", async () => {
  const opened = [];
  const { container, unmount } = await mount(
    "See [[Seed order]], [[Volunteer rota|the rota]] and [[Missing]].",
    { onOpen: (path) => opened.push(path) },
  );
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(
    links.map((link) => [link.getAttribute("href"), link.className, link.textContent]),
    [
      ["#note=Projects%2FSeed%20order.md", "wikilink", "Seed order"],
      ["#note=Reference%2FVolunteer%20rota.md", "wikilink", "the rota"],
      ["#note=Missing", "wikilink missing", "Missing"],
    ],
  );
  // Following a link opens that note in the page; a missing note goes nowhere.
  for (const link of links) link.click();
  assert.deepEqual(opened, ["Projects/Seed order.md", "Reference/Volunteer rota.md"]);
  await unmount();
});

test("image embeds load from the vault at their Obsidian size; other embeds stay names", async () => {
  const reads = [];
  const { container, unmount } = await mount(
    "![[lot-sketch.png|360]]\n\n![[lot-sketch.png|360x200]]\n\n![[clip.mp4]]",
    {
      loadFile: async (path) => {
        reads.push(path);
        return png();
      },
    },
  );
  const images = [...container.querySelectorAll("img")];
  assert.deepEqual(
    images.map((image) => [
      image.getAttribute("width"),
      image.getAttribute("height"),
      image.getAttribute("alt"),
      image.className,
      image.getAttribute("src")?.startsWith("blob:"),
    ]),
    [
      ["360", null, "lot-sketch", "embed-image", true],
      ["360", "200", "lot-sketch", "embed-image", true],
    ],
  );
  assert.deepEqual(reads, ["Attachments/lot-sketch.png", "Attachments/lot-sketch.png"]);
  assert.equal(container.querySelector("video"), null);
  assert.equal(container.querySelector(".embed-chip")?.textContent, "clip.mp4");
  await unmount();
});

test("an embed the vault can't read shows its name instead of a broken image", async () => {
  const { container, unmount } = await mount("![[lot-sketch.png|360]]");
  assert.equal(container.querySelector("img"), null);
  assert.equal(container.querySelector(".embed-chip")?.textContent, "lot-sketch.png");
  await unmount();
});

test("Obsidian callouts render with their type, title and body", async () => {
  const { container, unmount } = await mount("> [!tip] Water access\n> Hose on the east wall.");
  const callout = container.querySelector('[data-callout-type="tip"]');
  assert.ok(callout);
  assert.equal(callout.querySelector("[data-callout-title]")?.textContent?.trim(), "Water access");
  assert.equal(
    callout.querySelector("[data-callout-body]")?.textContent?.trim(),
    "Hose on the east wall.",
  );
  await unmount();
});

test("GFM task lists and tables render", async () => {
  const { container, unmount } = await mount(
    "- [x] done\n- [ ] todo\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  );
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(
    boxes.map((box) => box.checked),
    [true, false],
  );
  assert.deepEqual(
    [...container.querySelectorAll("td")].map((cell) => cell.textContent),
    ["1", "2"],
  );
  await unmount();
});

test("raw HTML never renders, only http(s) links stay links, and remote images never load", async () => {
  const reads = [];
  const { container, unmount } = await mount(
    "<script>alert(1)</script><img src=x onerror=alert(1)><b>bold</b>\n\n" +
      "[x](javascript:alert(1)) [y](https://example.com) ![remote](https://example.com/a.png)",
    {
      loadFile: async (path) => {
        reads.push(path);
        return png();
      },
    },
  );
  assert.equal(container.querySelector("script, b, [onerror]"), null);
  assert.equal(container.querySelector("img"), null);
  assert.equal(container.querySelector(".embed-missing")?.textContent, "remote");
  assert.deepEqual(reads, []);
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(
    links.map((link) => [link.getAttribute("href"), link.target, link.rel]),
    [["https://example.com", "_blank", "noopener noreferrer"]],
  );
  assert.ok(!container.innerHTML.includes("javascript:"));
  await unmount();
});
