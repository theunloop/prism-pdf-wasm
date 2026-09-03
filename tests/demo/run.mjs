// Drive the assembled demo in a real browser.
//
// The demo is the one place the whole package is used the way a consumer on a static host uses it
// — no bundler, `await init()` with no argument, files arriving from a file input rather than the
// filesystem. That path is worth a check of its own: everything here passes on Node long before
// any of it is known to work in a tab.
//
// Needs `npm run build && npm run build:demo` first, and the shared corpus for its fixtures.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = process.env.PRISMPDF_CORPUS ?? join(ROOT, "corpus");

if (!existsSync(join(CORPUS, "valid"))) {
  // The same courtesy the vitest suites extend: skip with a reason, never fail silently.
  console.log("skipped — shared corpus not found; run `npm run corpus` or set PRISMPDF_CORPUS");
  process.exit(0);
}
if (!existsSync(join(ROOT, "_site/index.html"))) {
  console.error("_site/ is missing — run `npm run build && npm run build:demo` first");
  process.exit(1);
}
const server = spawn("node", [join(ROOT, "build/serve-demo.mjs")], { env: { ...process.env, PORT: "8099" } });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}: ${e.message}`); }
};

await page.goto("http://localhost:8099/");
await page.waitForFunction(() => document.querySelector("#ver")?.textContent?.startsWith("engine"), null, { timeout: 30000 });

await check("engine version renders", async () => {
  const v = await page.textContent("#ver");
  if (!/^engine \d+\.\d+\.\d+/.test(v)) throw new Error(v);
});

await page.setInputFiles("#picker", join(CORPUS, "valid/two-pages-text.pdf"));
await page.waitForSelector("#ui:not([hidden])");

await check("the document opens with its page count", async () => {
  const facts = await page.textContent("#docfacts");
  if (!facts.includes("2 pages")) throw new Error(facts);
});

await check("handle counter is honest", async () => {
  const t = await page.textContent("#handles");
  if (!t.includes("1 document handle")) throw new Error(t);
});

await check("overview shows structure", async () => {
  const t = await page.textContent("#panel");
  if (!t.includes("Pages")) throw new Error("no Pages row");
  if (!t.includes("strict") && !t.includes("recovered")) throw new Error("no open mode");
});

for (const tab of ["pages", "text", "structure", "fonts", "images", "attachments"]) {
  await check(`${tab} tab renders`, async () => {
    await page.click(`[data-tab="${tab}"]`);
    const t = await page.textContent("#panel");
    if (!t || t.trim().length === 0) throw new Error("empty panel");
    if (t.includes("unexpected failure")) throw new Error(t.slice(0, 120));
  });
}

// Pages used to share this job with a second tab, Preview — a read-only picture with its own
// pager. It is gone: clicking a thumbnail now opens the same picture, full size, over the grid,
// which is exactly the "renders at all, admits whose pixels these are, doesn't leave a stale
// canvas" case Preview existed to check.
await check("the pages panel says the pixels are pdf.js's", async () => {
  await page.click('[data-tab="pages"]');
  await page.waitForSelector("#pagegrid .pcard");
  const t = await page.textContent("#panel .notice");
  if (!/pdf\.js/.test(t)) throw new Error(t.slice(0, 120));
  if (!/not by Prism/i.test(t)) throw new Error("the notice does not disclaim authorship");
});

await check("clicking a thumbnail opens the full-size viewer", async () => {
  await page.click("#pagegrid .pcard:first-child .frame");
  await page.waitForSelector("#lightbox.pageview #pvstage canvas", { timeout: 30000 });
  const painted = await page.evaluate(() => {
    const c = document.querySelector("#pvstage canvas");
    if (!c || c.width < 10 || c.height < 10) return false;
    // More than one distinct pixel value: ink on the page. Testing "not all white" would pass on a
    // canvas that was never drawn to at all, since an untouched one is transparent black.
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const first = d.slice(0, 4).join();
    for (let i = 4; i < d.length; i += 4) if (d.slice(i, i + 4).join() !== first) return true;
    return false;
  });
  if (!painted) throw new Error("canvas is missing, tiny, or uniformly blank");
  const err = (await page.textContent("#pverr")).trim();
  if (err) throw new Error(err);
});

await check("the viewer steps to the next card and reports the page size", async () => {
  await page.click("#pvnext");
  await page.waitForFunction(() => /card 2 of/.test(document.querySelector(".pageview-bar")?.textContent ?? ""));
  await page.waitForSelector("#pvstage canvas", { timeout: 30000 });
  await page.waitForFunction(() => /\d+×\d+ pt/.test(document.querySelector("#pvnote")?.textContent ?? ""));
  // Prism and pdf.js read the same bytes here; a disagreement about the page count is worth
  // knowing about rather than papering over.
  const note = await page.textContent("#pvnote");
  if (note.includes("Prism counts")) throw new Error(`page counts disagree — ${note}`);
});

await check("Escape closes the viewer", async () => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#lightbox")?.hidden === true);
});

// Two implementations, one file. `missing-startxref.pdf` is one Prism recovers and pdf.js refuses,
// which is the case the viewer has to get right: the failure is pdf.js's and must not read as the
// engine's. If the engine or pdf.js ever changes its mind about this file, this check says so.
await check("a file only Prism opens blames the right renderer", async () => {
  await page.setInputFiles("#picker", join(CORPUS, "malformed/missing-startxref.pdf"));
  await page.waitForFunction(() => document.querySelector("#docname")?.textContent === "missing-startxref.pdf");
  await page.click('[data-tab="pages"]');
  await page.waitForSelector("#pagegrid .pcard");
  await page.click("#pagegrid .pcard:first-child .frame");
  await page.waitForFunction(() => (document.querySelector("#pverr")?.textContent ?? "").trim(), null, { timeout: 20000 });
  const err = await page.textContent("#pverr");
  if (!/^pdf\.js could not open/.test(err.trim())) throw new Error(err);
  if (!err.includes("Prism opened it")) throw new Error("does not say the engine succeeded");
  if (/\.\./.test(err)) throw new Error(`doubled punctuation: ${err}`);
  await page.keyboard.press("Escape");
});

// Opening a file replaces whatever was open — there is only ever one document — so the editing
// checks below need a fresh one with more than the malformed fixture's single page.
await page.setInputFiles("#picker", join(CORPUS, "valid/two-pages-text.pdf"));
await page.waitForFunction(() => document.querySelector("#docname")?.textContent === "two-pages-text.pdf");

await check("text extraction shows page one", async () => {
  await page.click('[data-tab="text"]');
  const t = await page.textContent("#panel pre");
  if (!t.includes("Page one")) throw new Error(t.slice(0, 80));
});

// Editing is one panel: what used to be a Rewrite tab — a page range, a rotation by number and the
// three save modes — now lives in Pages, where each of them acts on a page you can see. The range
// field is the one that changed meaning, and these checks pin the new one: it ticks a selection,
// and the export is what writes a file.
await page.click('[data-tab="pages"]');
await page.waitForSelector("#pagegrid .pcard");

const ticked = () => page.locator("#pagegrid input[data-keep]:checked").count();

await check("a page range ticks a selection rather than saving a file", async () => {
  await page.fill("#range", "1");
  await page.click("#dosplit");
  await page.waitForFunction(() => /1 out/.test(document.querySelector(".readout")?.textContent ?? ""));
  if ((await ticked()) !== 1) throw new Error(`${await ticked()} pages ticked`);
  const err = await page.textContent("#spliterr");
  if (err.trim()) throw new Error(err);
});

await check("a bad range says so and leaves the selection alone", async () => {
  await page.fill("#range", "9-12");
  await page.click("#dosplit");
  const err = (await page.textContent("#spliterr")).trim();
  if (!err.includes("past the last page")) throw new Error(err || "(no message)");
  if ((await ticked()) !== 1) throw new Error("a refused range changed the selection");
});

// One page, twice, is what `extractPages([0, 0])` means — and the only way to ask for it here is
// visual, so the copy has to be a card of its own that can be dropped on its own.
await check("a page can be duplicated", async () => {
  await page.click("#pagegrid .pcard [data-dup]");
  await page.waitForFunction(() => /1 duplicated/.test(document.querySelector(".readout")?.textContent ?? ""));
  if ((await page.locator("#pagegrid .pcard").count()) !== 3) throw new Error("no extra card");
  if ((await ticked()) !== 2) throw new Error(`${await ticked()} ticked after duplicating`);
});

// The bug this pins: rotation belongs to the card, so turning one copy must not turn the other.
// It is also the case that cannot be done in one extraction, because `/Rotate` is a property of the
// page — so the export has to fall back to a document per page, and say so.
await check("turning one copy leaves the other alone", async () => {
  await page.click('#pagegrid .pcard:nth-child(2) [data-rot$=":90"]');
  await page.waitForFunction(() => /1 turned/.test(document.querySelector(".readout")?.textContent ?? ""));
  const badges = await page.locator("#pagegrid .pcard .rot").allTextContents();
  if (badges.join() !== "90°") throw new Error(`rotation badges: ${badges.join(" ")}`);
});

await check("export writes the pages that are ticked, in order", async () => {
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click("#doexport"),
  ]);
  if (!dl.suggestedFilename().endsWith(".pdf")) throw new Error(dl.suggestedFilename());
  const report = await page.textContent("#exportreport");
  if (!/1, 1/.test(report)) throw new Error(`the duplicate did not reach the output: ${report.slice(0, 160)}`);
  // Two angles of one page cannot share a document, so this export must have taken the per-page
  // path — and the report has to say which path it took rather than leaving it a mystery.
  if (!/one document per page, merged/.test(report)) throw new Error(report.slice(0, 200));
  const err = await page.textContent("#exporterr");
  if (err.trim()) throw new Error(err);

  // And the proof is in the bytes, not in the panel: two copies of one page, and `/Rotate` on
  // exactly one of them.
  const written = readFileSync(await dl.path()).toString("latin1");
  const rotations = [...written.matchAll(/\/Rotate\s+(-?\d+)/g)].map((m) => m[1]);
  if (rotations.join() !== "90") throw new Error(`/Rotate in the output: [${rotations.join(", ")}]`);
});

await check("the three write modes are compared", async () => {
  await page.click("#docompress");
  await page.waitForSelector("#sizes table");
  const rows = await page.locator("#sizes tr").count();
  if (rows !== 5) throw new Error(`${rows} rows`);
  const t = await page.textContent("#sizes");
  if (!t.includes("object streams")) throw new Error(t.slice(0, 100));
});

// One document at a time: closing it goes all the way back to nothing open, not to a second file
// waiting underneath — so the handle line clears and the empty state comes back.
await check("closing a file releases its handle", async () => {
  await page.click("#docclose");
  await page.waitForFunction(() => document.querySelector("#hero").hidden === false);
  const t = (await page.textContent("#handles")).trim();
  if (t) throw new Error(`handle line should be empty with nothing open: "${t}"`);
});

// --- the sample document -----------------------------------------------------------------------
//
// Everything above works from the shared corpus, which is deliberately minimal. The sample the
// demo offers on a first visit is the opposite: it exists so that every panel has something to
// read, and the checks below are what "something" means — an outline that nests, a link that
// leaves the document, a form field, an attachment, an XMP packet, and a raw image the page can
// draw. If build/make-sample.mjs ever stops producing one of them, a panel goes quietly empty.

await check("the sample document opens from the site", async () => {
  // The hero is up — the previous check closed the only open document — so this is its button.
  await page.click("#herosample");
  await page.waitForFunction(() =>
    document.querySelector("#docname")?.textContent === "prism-sample.pdf",
  );
  const facts = await page.textContent("#docfacts");
  if (!facts.includes("4 pages")) throw new Error(facts);
  if (!facts.includes("strict")) throw new Error("the sample should open strict");
});

await check("the sample's structure panel finds all four kinds", async () => {
  await page.click('[data-tab="structure"]');
  const t = await page.textContent("#panel");
  for (const want of [
    "The spectrum, in DeviceRGB", // an outline that nests
    "github.com/theunloop/prism-pdf-wasm", // a link that leaves the document
    "reader.name", // a form field, with its fully-qualified name
    "An annotation with a body", // an annotation the Text panel will not show
  ]) {
    if (!t.includes(want)) throw new Error(`structure panel is missing ${JSON.stringify(want)}`);
  }
});

await check("the images panel draws the sample's raw image", async () => {
  await page.click('[data-tab="images"]');
  await page.waitForSelector(".imgrid canvas");
  const drawn = await page.evaluate(() => {
    const c = document.querySelector(".imgrid canvas");
    // The sample's first image is a hue sweep, so a canvas that decoded it has many distinct
    // pixels. This is the engine's own output — `pageImages` samples, drawn by this page.
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return { w: c.width, h: c.height, colours: seen.size };
  });
  if (drawn.w !== 160 || drawn.h !== 40) throw new Error(`${drawn.w}×${drawn.h}`);
  if (drawn.colours < 100) throw new Error(`${drawn.colours} distinct colours — did it decode?`);
});

await check("the fonts panel names the Standard 14 as unembedded", async () => {
  await page.click('[data-tab="fonts"]');
  const t = await page.textContent("#panel");
  if (!t.includes("Referenced, not embedded")) throw new Error(t.slice(0, 120));
  if (!t.includes("Helvetica")) throw new Error("no Helvetica");
  if (t.includes("Embedded programs")) throw new Error("the sample embeds no program");
});

await check("the attachment comes back out of the file", async () => {
  await page.click('[data-tab="attachments"]');
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click("[data-att]"),
  ]);
  if (dl.suggestedFilename() !== "about-attachments.txt") throw new Error(dl.suggestedFilename());
});

await check("find extracts every page once and then matches", async () => {
  await page.click('[data-tab="find"]');
  await page.fill("#q", "WebAssembly");
  await page.waitForSelector("#hits li", { timeout: 15000 });
  const line = await page.textContent("#findreadout");
  if (!/indexed 4 pages/.test(line)) throw new Error(line);
  if (!/match/.test(line)) throw new Error(line);
  // The hit has to say where it is, or it is not a search result.
  const where = await page.textContent("#hits li .where");
  if (!/page \d+/.test(where)) throw new Error(where);
});

await check("a hit jumps to its page in the viewer", async () => {
  await page.click("#hits li button[data-jump]");
  await page.waitForFunction(() =>
    document.querySelector('[data-tab="pages"]')?.getAttribute("aria-selected") === "true",
  );
  await page.waitForSelector("#lightbox.pageview #pvstage canvas", { timeout: 30000 });
  await page.keyboard.press("Escape");
});

await check("thumbnails render on the page grid", async () => {
  await page.waitForFunction(() => document.querySelectorAll("#pagegrid .pcard .frame img").length >= 2, null, {
    timeout: 30000,
  });
});

// The Pages panel is the one place the demo composes engine calls rather than making one: a
// rotation is a whole new document, so N rotations are N rewrites, and the selection is applied
// once at the end. The report it prints afterwards is the engine's, not the page's.
await check("pages exports a reordered, rotated selection", async () => {
  await page.click('[data-tab="pages"]');
  await page.waitForSelector("#pagegrid .pcard");
  await page.click('[data-keep="1"]'); // drop page 2
  await page.click('[data-rot="2:90"]'); // and turn page 3
  await page.waitForFunction(() =>
    /3 out/.test(document.querySelector(".readout")?.textContent ?? ""),
  );
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click("#doexport"),
  ]);
  if (!dl.suggestedFilename().includes("edited")) throw new Error(dl.suggestedFilename());
  const report = await page.textContent("#exportreport");
  if (!report.includes("reconstructed")) throw new Error(report.slice(0, 160));
  // Extraction builds a fresh object graph; the report must say so rather than leave it to be
  // discovered by reopening the output.
  if (!report.includes("removed")) throw new Error("the report does not state what it dropped");
  if (!/1, 3, 4/.test(report)) throw new Error(`wrong order: ${report.slice(0, 200)}`);
  const err = await page.textContent("#exporterr");
  if (err.trim()) throw new Error(err);
});

await check("the overview offers the whole read path as JSON", async () => {
  await page.click('[data-tab="overview"]');
  // Either the clipboard takes it or the fallback saves a file; both end in a toast, and which one
  // happens depends on a permission this test has no business asserting on.
  await page.click("#copyreport");
  // Matched on content, not on "a toast exists": an earlier one may still be on screen.
  await page.waitForFunction(
    () => [...document.querySelectorAll("#toasts div")].some((d) => /JSON|report/i.test(d.textContent)),
    null,
    { timeout: 10000 },
  );
});

// The switch offers light and dark; "system" is the state before either has been picked, and the
// pressed segment is then a reading of the system rather than a choice. Both halves are checked
// because the failure that matters is a switch whose highlight disagrees with the page.
await check("the theme switch picks a side and remembers it", async () => {
  const state = async () =>
    page.evaluate(() => ({
      attr: document.documentElement.dataset.theme ?? "system",
      stored: localStorage.getItem("prism-demo-theme"),
      pressed: [...document.querySelectorAll("#theme [data-theme-set]")]
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.dataset.themeSet),
      following: document.querySelector("#theme").dataset.following,
    }));

  const before = await state();
  if (before.attr !== "system" || before.following !== "true") throw new Error(JSON.stringify(before));
  // Nothing is chosen yet, and exactly one segment still has to be lit — whichever the system says.
  if (before.pressed.length !== 1) throw new Error(JSON.stringify(before));

  for (const want of ["dark", "light"]) {
    await page.click(`#theme [data-theme-set="${want}"]`);
    const now = await state();
    if (now.attr !== want) throw new Error(`root says ${now.attr}, asked for ${want}`);
    if (now.stored !== want) throw new Error(`stored ${now.stored}, asked for ${want}`);
    if (now.pressed.join() !== want) throw new Error(`pressed ${now.pressed.join()}`);
    if (now.following !== "false") throw new Error("still following the system after a choice");
  }

  // The choice has to survive a reload, which is the only thing localStorage is here for.
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#ver")?.textContent?.startsWith("engine"), null, { timeout: 30000 });
  const after = await state();
  if (after.attr !== "light" || after.pressed.join() !== "light") throw new Error(JSON.stringify(after));
});

console.log(results.join("\n"));
console.log(errors.length ? `\nconsole/page errors:\n${errors.join("\n")}` : "\nno console errors");
const failed = results.filter((r) => r.includes("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} demo checks passed`);

await browser.close();
server.kill();
process.exit(failed || errors.length ? 1 : 0);
