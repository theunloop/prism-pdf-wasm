/**
 * Drive the browser harness under headless Chromium.
 *
 * A static file server plus Playwright, rather than a browser-mode test runner: the thing under
 * test is how the package behaves when a browser fetches it over HTTP with the right MIME types,
 * and a runner that transforms the modules on the way in would be testing its own pipeline.
 *
 * Exits non-zero on the first failed check, so CI reads it like any other suite.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = process.env.PRISMPDF_CORPUS ?? join(root, "corpus");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  // The one that matters: `WebAssembly.instantiateStreaming` refuses anything else, and serving
  // it as application/octet-stream is the single most common way a wasm package fails in a
  // browser but not in Node.
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const path =
    url === "/" ? join(root, "tests/browser/page.html")
    : url === "/fixture.pdf" ? join(corpus, "valid/two-pages-text.pdf")
    : url.startsWith("/dist/") || url.startsWith("/pkg/") ? join(root, normalize(url).slice(1))
    : join(root, "tests/browser", normalize(url).slice(1));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end(`not found: ${path}`);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(base);
await page.waitForFunction(() => window.__results !== undefined, null, { timeout: 60_000 });
const results = await page.evaluate(() => window.__results);

await browser.close();
server.close();

if (results.fatal) {
  console.error("fatal:", results.fatal);
  process.exit(1);
}
let failed = 0;
for (const { name, ok, error } of results) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${error ? `  — ${error}` : ""}`);
  if (!ok) failed++;
}
for (const error of consoleErrors) console.error("page error:", error);
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed === 0 && consoleErrors.length === 0 ? 0 : 1);
