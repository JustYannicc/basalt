import { createRequire } from "node:module";

const require = createRequire(new URL("../.upstream/package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true });
await browser.close();
