// The demo's whole application. Deliberately dependency-free and un-bundled: what it shows off is
// the package, so anything that transformed the package on the way in would be showing off that
// instead.
//
// Two rules run through all of it.
//
// Every `Document` opened here is tracked and closed. The wasm heap is not the JavaScript heap, and
// only one document is ever open at a time — opening a new one closes whatever was there first —
// so the rail's handle line only ever has to say 0 or 1, and it says so honestly either way.
//
// Every number the page prints is measured. Each panel carries a readout line saying what the
// engine did and how long the call took, timed with `performance.now()` around the call itself. A
// demo that asserted "it's fast" would be asking to be believed; this one shows its working, and
// occasionally shows an unflattering number, which is the point.
import init, {
  Document,
  PrismPdfError,
  engineVersion,
  mergeWithReport,
  statusName,
} from "./dist/index.web.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  // One document at a time, on purpose — see "Loading and disposal" below.
  file: null,
  tab: "overview",
  seq: 0,
  // Per-panel view state. Reset when the active file changes, since a page number means nothing
  // once you are looking at a different document.
  page: 0,
  positioned: false,
  imgPage: 0,
  imgAll: false,
  // The big page viewer opens over the Pages grid, not beside it — `viewSlot` is the id of the
  // slot it is showing, or `null` when it is closed.
  viewSlot: null,
  viewZoom: "page",
  query: "",
};

// Switching or closing a file with the big viewer open would otherwise leave it showing a page
// from a document that is no longer the active one — or, worse, one whose handle just closed.
const resetView = () => {
  Object.assign(state, { page: 0, imgPage: 0, imgAll: false, viewSlot: null, query: "" });
  const box = $("#lightbox");
  if (box && !box.hidden) {
    box.hidden = true;
    box.className = "";
    box.replaceChildren();
  }
};

// --- small helpers -----------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function kb(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const pct = (n) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Run something and keep the wall time. The unit the whole page is calibrated in. */
function timed(fn) {
  const at = performance.now();
  const v = fn();
  return { v, ms: performance.now() - at };
}

/** A duration, at a precision that does not pretend to more resolution than the clock has. */
const dur = (n) => (n < 1 ? `${n.toFixed(2)} ms` : n < 1000 ? `${n.toFixed(1)} ms` : `${(n / 1000).toFixed(2)} s`);
const ms = (n) => `<span class="ms">${dur(n)}</span>`;

/** The line at the top of every panel: what the engine was asked, and what it cost. */
const readout = (items) =>
  `<p class="readout">${items.filter(Boolean).map((s) => `<span>${s}</span>`).join("")}</p>`;

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on the next turn: revoking synchronously can race the click in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${name} — ${kb(bytes.length)}`);
}

function saveBlob(data, name, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${name}`);
}

function toast(text) {
  const el = document.createElement("div");
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Run an engine call and turn a failure into a fallback instead of a blank panel. */
function attempt(fn, fallback = null) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PrismPdfError) return fallback;
    throw e;
  }
}

/** Report a failure to the user with the engine's stable status name attached. */
function fail(e) {
  if (e instanceof PrismPdfError) return `${e.message} (${statusName(e.status)})`;
  // Not an engine status: a wasm trap, or a bug here. Say so rather than dressing it up.
  return `unexpected failure — ${e?.message ?? e}`;
}

function date(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, "0");
  const zone =
    d.utcOffsetMinutes === null
      ? "no UTC offset declared"
      : `UTC${d.utcOffsetMinutes < 0 ? "-" : "+"}${p((Math.abs(d.utcOffsetMinutes) / 60) | 0)}:${p(
          Math.abs(d.utcOffsetMinutes) % 60,
        )}`;
  return `${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}:${p(d.second)} <span class="hint">${zone}</span>`;
}

const active = () => state.file;
const baseName = (f) => f.name.replace(/\.pdf$/i, "");

// --- theme -------------------------------------------------------------------------------------
//
// The switch offers two states, light and dark, because those are the two things a visitor wants.
// Internally there are three: until someone picks one, the page stamps nothing on the root element
// and lets `prefers-color-scheme` decide — so arriving in a dark system means arriving in the dark
// theme, and the switch shows which of the two you are actually looking at rather than the word
// "system".

const media = matchMedia("(prefers-color-scheme: dark)");
let theme = "system";

/** The theme on screen, which is a reading of the system when nothing has been chosen. */
const effectiveTheme = () => (theme === "system" ? (media.matches ? "dark" : "light") : theme);

function applyTheme(choice, { remember = true } = {}) {
  theme = choice;
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;

  const showing = effectiveTheme();
  const box = $("#theme");
  box.dataset.following = String(theme === "system");
  box.title =
    theme === "system"
      ? `Following your system setting, which is ${showing} right now`
      : `Set to the ${showing} theme`;
  for (const button of box.querySelectorAll("[data-theme-set]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeSet === showing));
  }

  if (!remember) return;
  try {
    localStorage.setItem("prism-demo-theme", choice);
  } catch {
    // A browser with site data blocked still gets a working switch, just not a remembered one.
  }
}

// While nothing has been chosen, the system is the choice — so a system that changes its mind
// mid-visit moves the page with it, and the switch's highlight follows.
media.addEventListener("change", () => {
  if (theme === "system") applyTheme("system", { remember: false });
});

// --- loading and disposal ----------------------------------------------------------------------
//
// One document at a time. It is a real constraint, not a shortcut taken and left undocumented: it
// keeps the wasm-heap-versus-JS-heap point the rail makes (below) legible as "the open document, or
// none" rather than a count to audit, and it means an editing session is always about *the* file
// rather than *a* file among several. Opening a new one closes whatever was open, the same way
// closing it explicitly does — there is exactly one `release` path, used both ways.

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(file.name, bytes);
}

async function openBytes(name, bytes) {
  if (state.file) release(state.file);
  const entry = {
    id: ++state.seq,
    name,
    size: bytes.length,
    bytes,
    doc: null,
    error: null,
    openMs: 0,
    pageCount: 0,
    summary: null,
    preview: null,
    thumbs: new Map(),
    text: null,
    textMs: 0,
    faces: [],
    edit: null,
  };
  try {
    const opened = timed(() => Document.open(bytes));
    entry.doc = opened.v;
    entry.openMs = opened.ms;
    entry.pageCount = entry.doc.pageCount;
    // Two cheap totals, taken once, so the tab strip can carry counts without calling the engine
    // again on every re-render.
    entry.summary = {
      fonts: attempt(() => entry.doc.fonts().length, 0),
      attachments: attempt(() => entry.doc.attachments().length, 0),
      outline: attempt(() => entry.doc.outline().length, 0),
    };
  } catch (e) {
    entry.error = fail(e);
  }
  state.file = entry;
  resetView();
  render();
  return entry;
}

/** Everything a file holds that is not the JavaScript object itself. */
function release(f) {
  f.doc?.close();
  f.doc = null;
  f.preview?.then((pdf) => pdf.destroy()).catch(() => {});
  f.preview = null;
  for (const face of f.faces) document.fonts.delete(face);
  f.faces = [];
}

function closeFile() {
  if (!state.file) return;
  // The whole point: release the wasm handle before dropping the JS object that referenced it.
  release(state.file);
  const gone = state.file;
  state.file = null;
  resetView();
  render();
  toast(`Closed ${gone.name}`);
}

// Closing on unload is not a guarantee of anything — the instance dies with the page either way —
// but it keeps the invariant true for the whole life of the document.
addEventListener("pagehide", () => state.file && release(state.file));

let sampleBytes = null;

/**
 * The sample document, written at build time by `build/make-sample.mjs`.
 *
 * Fetched from this site, on demand, and never at load: a visitor who arrives with a file of their
 * own should not pay for one they will not look at.
 */
async function openSample() {
  if (state.file?.name === "prism-sample.pdf") return; // already open
  try {
    if (!sampleBytes) {
      const res = await fetch("./sample/prism-sample.pdf");
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      sampleBytes = new Uint8Array(await res.arrayBuffer());
    }
    await openBytes("prism-sample.pdf", sampleBytes);
  } catch (e) {
    toast(`Could not load the sample document — ${e.message}. Open a file of your own instead.`);
  }
}

// --- pdf.js: the one part of this page that is not Prism ----------------------------------------
//
// The engine has no rasterizer — page rendering is out of scope for its v1 — so every *picture of a
// page* here, in the preview and in the thumbnails, is drawn by Mozilla's pdf.js, vendored under
// vendor/pdfjs/ and loaded only when something asks for a picture. That is said on the panels
// themselves rather than only here: a page that let visitors assume Prism drew these images would
// be demonstrating something the engine cannot do.
//
// Two implementations reading the same bytes side by side turns out to be the interesting part. The
// page count beside the canvas comes from Prism and the pixels from pdf.js, so where they disagree
// the panel says so rather than quietly showing one of them.

const PDFJS = "./vendor/pdfjs/";
let pdfjsModule = null;

/** Load pdf.js on first use — 460 KB that a visitor who never asks for a page image never pays. */
function pdfjs() {
  pdfjsModule ??= import(`${PDFJS}pdf.min.js`).then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
    return m;
  });
  return pdfjsModule;
}

/**
 * The pdf.js document for one file, opened once and kept.
 *
 * It is handed a *copy* of the bytes on purpose: pdf.js transfers the buffer it is given to its
 * worker, which would detach the array this page still needs for the size comparison under Pages.
 */
function previewOf(f) {
  f.preview ??= pdfjs().then(({ getDocument }) =>
    getDocument({
      data: new Uint8Array(f.bytes),
      // All vendored beside the library, and all fetched lazily — only a document that needs a CJK
      // CMap, an unembedded Standard 14 face, a JPEG 2000 image or an ICC profile pays for one.
      cMapUrl: `${PDFJS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS}standard_fonts/`,
      wasmUrl: `${PDFJS}wasm/`,
      iccUrl: `${PDFJS}iccs/`,
    }).promise,
  );
  return f.preview;
}

/** A pdf.js failure, as one clause. Its messages are sentences; these are read mid-sentence. */
const why = (e) => String(e?.message ?? e).replace(/\.\s*$/, "");

// Thumbnails are rendered one at a time. pdf.js has a single worker, and firing forty page renders
// at it because forty cards scrolled into view makes every one of them late.
const thumbQueue = [];
let thumbBusy = false;

function requestThumb(f, page, slot) {
  if (f.thumbs.has(page)) {
    const cached = f.thumbs.get(page);
    if (cached) slot.replaceChildren(thumbImage(cached, page));
    else slot.innerHTML = `<span class="hint">no image</span>`;
    return;
  }
  thumbQueue.push({ f, page });
  runThumbQueue();
}

function thumbImage(src, page) {
  const img = new Image();
  img.src = src;
  img.alt = `Page ${page + 1}`;
  return img;
}

async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const { f, page } = thumbQueue.shift();
      if (!f.doc || f.thumbs.has(page)) continue;
      try {
        const pdf = await previewOf(f);
        if (page >= pdf.numPages) continue;
        const proxy = await pdf.getPage(page + 1);
        const base = proxy.getViewport({ scale: 1 });
        const scale = 200 / base.width;
        const viewport = proxy.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await proxy.render({ canvas, viewport }).promise;
        proxy.cleanup();
        f.thumbs.set(page, canvas.toDataURL("image/png"));
      } catch {
        // A page pdf.js cannot draw leaves its card empty rather than taking the panel with it.
        f.thumbs.set(page, "");
      }
      for (const slot of $$(`[data-thumb="${f.id}:${page}"]`)) {
        const src = f.thumbs.get(page);
        if (src) slot.replaceChildren(thumbImage(src, page));
        else slot.innerHTML = `<span class="hint">no image</span>`;
      }
    }
  } finally {
    thumbBusy = false;
  }
}

/** Ask for a thumbnail when its card scrolls into view, and not before. */
let thumbWatcher = null;
function watchThumbs(f) {
  thumbWatcher?.disconnect();
  thumbWatcher = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        const page = Number(entry.target.dataset.thumb.split(":")[1]);
        requestThumb(f, page, entry.target);
      }
    },
    { rootMargin: "200px" },
  );
  for (const slot of $$("[data-thumb]")) thumbWatcher.observe(slot);
}

// --- Overview ----------------------------------------------------------------------------------

function overviewPanel(doc, f) {
  const report = doc.openReport;
  const info = (k) => attempt(() => doc.info(k));
  const meta = timed(() => ({
    title: info("Title"),
    author: info("Author"),
    subject: info("Subject"),
    keywords: info("Keywords"),
    creator: info("Creator"),
    producer: info("Producer"),
    created: attempt(() => doc.creationDate),
    modified: attempt(() => doc.modificationDate),
    xmp: attempt(() => doc.xmp),
  }));

  // The value is what the API returned, spelled the way the API spells it — `openReport.mode` is
  // the string "strict" or "recovered", and a tile that title-cased it would be inventing a name.
  const tiles = [
    [doc.pageCount, "Pages"],
    [kb(f.size), "On disk"],
    [report.mode, report.mode === "recovered" ? "Cross-reference rebuilt" : "Cross-reference as written"],
    [doc.version ? `${doc.version.major}.${doc.version.minor}` : "—", doc.version ? "Header version" : "No header version"],
    [`${doc.minVersion.major}.${doc.minVersion.minor}`, "Minimum reader version"],
    [f.summary.fonts, "Fonts referenced"],
  ];

  const rows = [
    ["Title", meta.v.title],
    ["Author", meta.v.author],
    ["Subject", meta.v.subject],
    ["Keywords", meta.v.keywords],
    ["Creator", meta.v.creator],
    ["Producer", meta.v.producer],
    ["Created", date(meta.v.created)],
    ["Modified", date(meta.v.modified)],
  ].filter(([, v]) => v);

  let html = readout([
    `opened <b>${esc(f.name)}</b>`,
    `${kb(f.size)} → ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`,
    `open ${ms(f.openMs)}`,
    `metadata ${ms(meta.ms)}`,
  ]);

  html += `<div class="tiles">${tiles
    .map(([v, k]) => `<div class="tile"><span class="v">${esc(v)}</span><span class="k">${esc(k)}</span></div>`)
    .join("")}</div>`;

  html += `<h2 class="panel-h">Document information</h2>`;
  html += rows.length
    ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === "Created" || k === "Modified" ? v : esc(v)}</dd>`).join("")}</dl>`
    : `<p class="sub">This document carries no /Info dictionary entries.</p>`;

  if (report.diagnostics.length) {
    html += `<h2 class="panel-h">Why recovery ran</h2>
      <p class="sub">Recovered means the cross-reference table was rebuilt — not that the parser was
      lenient about the content. At most two diagnostics are kept.</p>
      <div class="scroll"><table><thead><tr><th>Reason</th><th class="num">Byte offset</th></tr></thead><tbody>${report.diagnostics
        .map((d) => `<tr><td class="mono">${esc(d.reason)}</td><td class="num">${d.offset ?? "—"}</td></tr>`)
        .join("")}</tbody></table></div>`;
  }

  html += `<h2 class="panel-h">XMP metadata</h2>`;
  html += meta.v.xmp
    ? `<p class="sub">The packet as stored, ${kb(meta.v.xmp.length)} of it, untouched.</p><pre>${esc(meta.v.xmp)}</pre>`
    : `<p class="sub">This document carries no XMP packet.</p>`;

  html += `<div class="row" style="margin-top:20px">
    <button class="act ghost" id="copyreport">Copy everything as JSON</button>
    <span class="hint">Metadata, fonts, outline, annotations and attachment names — as one object.</span>
  </div>`;
  return html;
}

/** Everything the read path can say about a document, as one JSON object. */
function inspectionReport(doc, f) {
  const at = performance.now();
  const pages = [];
  for (let p = 0; p < Math.min(doc.pageCount, 500); p++) {
    pages.push({
      index: p,
      characters: attempt(() => doc.pageText(p).length, null),
      annotations: attempt(() => doc.pageAnnotations(p), []),
      images: attempt(() => doc.pageImages(p), []).map(({ data, ...rest }) => ({ ...rest, bytes: data.length })),
    });
  }
  const report = {
    file: { name: f.name, bytes: f.size },
    engine: engineVersion(),
    open: { mode: doc.openReport.mode, diagnostics: doc.openReport.diagnostics, ms: Number(f.openMs.toFixed(3)) },
    version: doc.version,
    minVersion: doc.minVersion,
    pageCount: doc.pageCount,
    info: Object.fromEntries(
      ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]
        .map((k) => [k, attempt(() => doc.info(k))])
        .filter(([, v]) => v),
    ),
    creationDate: attempt(() => doc.creationDate),
    modificationDate: attempt(() => doc.modificationDate),
    hasXmp: Boolean(attempt(() => doc.xmp)),
    fonts: attempt(() => doc.fonts(), []).map((font) => ({
      baseFont: font.baseFont,
      subtype: font.subtype,
      embedded: font.embedded && {
        format: font.embedded.format,
        bytes: font.embedded.program.length,
        metrics: font.embedded.metrics,
      },
    })),
    outline: attempt(() => doc.outline(), []),
    formFields: attempt(() => doc.formFields(), []),
    attachments: attempt(() => doc.attachments(), []).map(({ data, ...rest }) => ({ ...rest, bytes: data.length })),
    pages,
  };
  return { report, ms: performance.now() - at };
}

// --- Pages: the big page viewer ------------------------------------------------------------
//
// There used to be a second tab for this — Preview, a read-only picture with its own pager and
// zoom. It showed nothing the grid below did not already have a thumbnail of, and it disagreed
// with the grid about which page you were looking at. So it is not a tab any more: clicking a
// thumbnail opens the same page, full size, in the overlay every other magnified view on this
// page already uses (`#lightbox`) — one picture-of-a-page feature, not two.

const ZOOMS = [
  ["fit", "fit width"],
  ["page", "fit page"],
  ["0.5", "50%"],
  ["1", "100%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["4", "400%"],
];

// A very long document gets a bounded strip. The engine has no trouble with the page count; a
// thousand DOM cards and a thousand queued renders are this page's problem, not the engine's.
const THUMB_CAP = 400;

function pageViewShell(f, idx) {
  const edit = editOf(f);
  const slot = edit.slots[idx];
  const zoom = String(state.viewZoom);
  return `
    <div class="pageview-bar">
      <button class="act ghost tiny" id="pvprev" ${idx === 0 ? "disabled" : ""} title="Previous card (left arrow)">‹ Previous</button>
      <span class="hint">card <b>${idx + 1}</b> of ${edit.slots.length} — page <b>${slot.page + 1}</b> in the file${
        slot.deg ? `, turned <b>${slot.deg}°</b>` : ""
      }</span>
      <button class="act ghost tiny" id="pvnext" ${idx === edit.slots.length - 1 ? "disabled" : ""} title="Next card (right arrow)">Next ›</button>
      <span class="grow"></span>
      <label>Zoom
        <select id="pvzoom">${ZOOMS.map(
          ([v, label]) => `<option value="${v}" ${v === zoom ? "selected" : ""}>${label}</option>`,
        ).join("")}</select>
      </label>
      <button class="act ghost tiny" id="pvclose" data-close title="Close (Esc)">✕</button>
    </div>
    <p class="err" id="pverr"></p>
    <div id="pvstage"><p class="hint">rendering…</p></div>
    <figcaption class="readout" id="pvnote">measuring…</figcaption>`;
}

/** Open the big view of one card. Re-entrant: calling it again while it is open just repaints it. */
let pageViewToken = 0;
async function openPageView(f, slotId) {
  const edit = editOf(f);
  const idx = edit.slots.findIndex((slot) => slot.id === slotId);
  if (idx < 0) return;
  state.viewSlot = slotId;
  const box = $("#lightbox");
  box.className = "pageview";
  box.hidden = false;
  const figure = document.createElement("figure");
  figure.innerHTML = pageViewShell(f, idx);
  box.replaceChildren(figure);
  wirePageView(f);
  await paintPageView(f);
}

function closePageView() {
  const box = $("#lightbox");
  box.hidden = true;
  box.className = "";
  box.replaceChildren();
  state.viewSlot = null;
}

function stepPageView(f, by) {
  const edit = editOf(f);
  const at = edit.slots.findIndex((slot) => slot.id === state.viewSlot);
  const next = edit.slots[Math.min(Math.max(0, at + by), edit.slots.length - 1)];
  if (next && next.id !== state.viewSlot) openPageView(f, next.id);
}

function wirePageView(f) {
  $("#pvprev")?.addEventListener("click", () => stepPageView(f, -1));
  $("#pvnext")?.addEventListener("click", () => stepPageView(f, 1));
  $("#pvclose")?.addEventListener("click", closePageView);
  $("#pvzoom")?.addEventListener("change", (e) => {
    state.viewZoom = e.target.value;
    paintPageView(f);
  });
}

/** Draw the card's page into the open viewer, at its own rotation. */
async function paintPageView(f) {
  const token = ++pageViewToken;
  const stage = $("#pvstage");
  const err = $("#pverr");
  const note = $("#pvnote");
  if (!stage) return;
  // The viewer can be closed, stepped, or re-zoomed before a slow render finishes; a stale draw
  // must not land on a stage nobody asked for any more.
  const current = () => token === pageViewToken && stage.isConnected;
  const edit = editOf(f);
  const slot = edit.slots.find((s) => s.id === state.viewSlot);
  if (!slot) return;

  let pdf;
  const openedAt = performance.now();
  try {
    pdf = await previewOf(f);
  } catch (e) {
    if (!current()) return;
    stage.hidden = true;
    note.hidden = true;
    // Whose failure this is matters. Prism opened this file — the viewer must not read as though
    // the engine had rejected it.
    err.textContent = `pdf.js could not open this file — ${why(e)}. Prism opened it, so the two disagree about it.`;
    return;
  }
  if (!current()) return;
  const openMs = performance.now() - openedAt;

  const facts = [];
  if (pdf.numPages !== f.pageCount) {
    facts.push(`<b>pdf.js counts ${pdf.numPages} page(s) here, Prism counts ${f.pageCount}</b>`);
  }
  if (slot.page >= pdf.numPages) {
    stage.hidden = true;
    err.textContent = `pdf.js finds no page ${slot.page + 1} in this file.`;
    note.innerHTML = facts.join("");
    return;
  }

  let proxy = null;
  try {
    proxy = await pdf.getPage(slot.page + 1);
    if (!current()) return;

    const unscaled = proxy.getViewport({ scale: 1 });
    const swapped = slot.deg === 90 || slot.deg === 270;
    const boxW = swapped ? unscaled.height : unscaled.width;
    const boxH = swapped ? unscaled.width : unscaled.height;
    const choice = String(state.viewZoom);
    const room = Math.max(160, stage.clientWidth - 40);
    // "Fit page" means fit the room the viewer itself has, not a fraction of the window: the stage
    // sits under a toolbar, and a canvas sized against the whole viewport runs off it.
    const headroom = Math.max(240, innerHeight * 0.7);
    const scale =
      choice === "fit"
        ? room / boxW
        : choice === "page"
          ? Math.min(room / boxW, headroom / boxH)
          : Number(choice);
    // Draw at device resolution and scale back down in CSS, or the page is soft on a HiDPI screen.
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const viewport = proxy.getViewport({ scale: scale * ratio });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.round(viewport.width / ratio)}px`;
    canvas.style.height = `${Math.round(viewport.height / ratio)}px`;

    const drawnAt = performance.now();
    await proxy.render({ canvas, viewport }).promise;
    if (!current()) return;
    const drawMs = performance.now() - drawnAt;

    // The rotation is the card's, not the file's — pdf.js draws the page as Prism still has it, and
    // this is the same CSS turn the thumbnail uses, just without the thumbnail's shrink-to-fit.
    const wrap = document.createElement("div");
    wrap.className = "pvrot";
    wrap.style.setProperty("--deg", `${slot.deg}deg`);
    wrap.style.width = `${Math.round((swapped ? viewport.height : viewport.width) / ratio)}px`;
    wrap.style.height = `${Math.round((swapped ? viewport.width : viewport.height) / ratio)}px`;
    wrap.append(canvas);
    stage.replaceChildren(wrap);

    note.innerHTML = [
      `page <b>${slot.page + 1}</b> of ${pdf.numPages}${
        slot.deg ? `, turned <b>${slot.deg}°</b> — not applied until export` : ""
      }`,
      `<b>${Math.round(unscaled.width)}×${Math.round(unscaled.height)} pt</b> at ${Math.round(scale * 100)}%`,
      `pdf.js open ${ms(openMs)}`,
      `pdf.js draw ${ms(drawMs)}`,
      ...facts,
    ]
      .map((s) => `<span>${s}</span>`)
      .join("");
  } catch (e) {
    if (!current()) return;
    stage.hidden = true;
    err.textContent = `pdf.js could not render page ${slot.page + 1} — ${why(e)}`;
  } finally {
    proxy?.cleanup();
  }
}

/** "Show the page" — from a search hit or an outline/link destination. Opens the viewer on the
 * first card still showing that page, which is the source page itself unless it was dropped and
 * duplicated into something else entirely. */
function jumpToPage(index) {
  const f = active();
  if (!f?.doc) return;
  const edit = editOf(f);
  const slot = edit.slots.find((s) => s.page === index) ?? edit.slots[0];
  if (!slot) return;
  state.tab = "pages";
  render();
  openPageView(f, slot.id);
}

// --- Pages: the editor -------------------------------------------------------------------------
//
// Editing a PDF here is done by looking at it. This is the only panel that changes a document, and
// everything it can do is a thing you do to a page you can see: untick it to drop it, drag it to
// move it, duplicate it, turn it. The text field is a *selector*, not a second way to edit — it
// ticks the pages you name and then gets out of the way.
//
// The engine has no page handle and no mutation: `extractPages` describes a selection in an order,
// and `rotatePage` returns a whole new document. So the edit is kept as plain data — a list of
// slots and a rotation per page — and no engine call happens until you export.
//
// A slot is not a page. Slots carry their own identity so that one page can appear twice (which is
// what `extractPages([0, 0])` is for), and everything you do to a card — keeping it, moving it,
// turning it — is a property of the slot, not of the page it points at. Turning one copy turns one
// copy.
//
// That last part costs something at export, and it is worth knowing why. `/Rotate` lives on the
// page, so two rotations of one page cannot exist in a single document: when a page appears twice
// at different angles, each copy has to be extracted from its own rotated document and the results
// merged. `applyEdit` takes the cheap path when it can and says which path it took.

function editOf(f) {
  f.edit ??= {
    seq: f.pageCount,
    slots: Array.from({ length: f.pageCount }, (_, i) => ({ id: i, page: i, keep: true, deg: 0 })),
  };
  return f.edit;
}

const keptSlots = (edit) => edit.slots.filter((slot) => slot.keep);

function pagesPanel(doc, f) {
  const edit = editOf(f);
  const kept = keptSlots(edit);
  // Reordered means a page now follows one that used to come after it. Comparing each slot to its
  // index would call a duplicate a reorder, which it is not.
  const moved = edit.slots.some((slot, i) => i > 0 && slot.page < edit.slots[i - 1].page);
  const dropped = edit.slots.filter((slot) => !slot.keep).length;
  const copies = edit.slots.length - f.pageCount;
  const turned = edit.slots.filter((slot) => slot.deg).length;
  const touched = moved || dropped || copies || turned;
  return `
    <div class="notice">
      <strong>The pictures of pages here are drawn by pdf.js, not by Prism.</strong>
      Prism has no rasterizer — page rendering is out of scope for the engine's v1 — so every
      thumbnail, and the full-size view a click opens, comes from
      <a href="https://mozilla.github.io/pdf.js/" rel="noopener">Mozilla's pdf.js</a> (Apache-2.0,
      <a href="./vendor/pdfjs/LICENSE">licence</a>), vendored into this site and loaded only when
      you ask for one. The selection, the order, the angles and the file you export are Prism's.
    </div>
    ${readout([
      `<b>${f.pageCount}</b> pages in`,
      `<b>${kept.length}</b> out`,
      dropped ? `<b>${dropped}</b> dropped` : null,
      copies ? `<b>${copies}</b> duplicated` : null,
      turned ? `<b>${turned}</b> turned` : null,
      moved ? "<b>reordered</b>" : null,
      touched ? "no engine call yet — export applies the edit" : "nothing changed yet",
    ])}
    <div class="row">
      <button class="act" id="doexport" ${kept.length ? "" : "disabled"}>Export ${kept.length} page${kept.length === 1 ? "" : "s"}</button>
      <button class="act ghost" id="pickall">Keep all</button>
      <button class="act ghost" id="pickinv">Invert</button>
      <button class="act ghost" id="editreset" ${touched ? "" : "disabled"}>Reset</button>
      <span class="grow"></span>
      <label>Tick only
        <input type="text" id="range" value="" placeholder="1-3,7" style="width:8em"
               title="Tick just these pages, one-based" />
      </label>
      <button class="act ghost" id="dosplit">Apply</button>
    </div>
    <p class="err" id="spliterr"></p>
    <p class="hint">Drag a page to move it. Untick to drop it. <b>⧉</b> duplicates, <b>↺ ↻</b> turn
      — each card on its own, copies included. Click a thumbnail to open it full size.</p>
    <p class="err" id="exporterr"></p>
    <ul id="pagegrid">${edit.slots.slice(0, THUMB_CAP).map((slot, at) => pageCard(f, slot, at)).join("")}</ul>
    ${
      edit.slots.length > THUMB_CAP
        ? `<p class="hint">Showing the first ${THUMB_CAP} of ${edit.slots.length} pages. Export takes them all.</p>`
        : ""
    }
    <div id="exportreport"></div>
    <p class="provenance">
      Export runs one <code>extractPages</code> over the indices shown when every copy of a page
      shares an angle, and otherwise a <code>rotatePage</code> and an <code>extractPages</code> per
      page with a <code>merge</code> at the end — because <code>/Rotate</code> belongs to the page,
      so one page at two angles cannot live in one document. The report after an export says which
      ran.
    </p>

    <h2 class="panel-h">Write the whole file, three ways</h2>
    <p class="sub">Not an edit — the same pages, serialised differently. Object streams (§7.5.7) are
      usually the smallest; the engine normalises and repairs on all three, so the output is never
      byte-identical to the input even when it is larger.</p>
    <div class="row"><button class="act ghost" id="docompress">Compare all three</button></div>
    <div id="sizes"></div>`;
}

function pageCard(f, slot, at) {
  const edit = editOf(f);
  const deg = slot.deg;
  // Only the later occurrences are copies. The first one is where the page already was.
  const copy = edit.slots.findIndex((other) => other.page === slot.page) !== at;
  return `
    <li class="pcard ${slot.keep ? "" : "off"}" data-slot="${slot.id}" draggable="true">
      <input class="pick" type="checkbox" ${slot.keep ? "checked" : ""} data-keep="${slot.id}"
             title="${slot.keep ? "Drop this page" : "Keep this page"}" />
      <span class="frame" data-thumb="${f.id}:${slot.page}" data-view="${slot.id}"
            title="Open full size" style="--deg:${deg}deg; --sc:${deg === 90 || deg === 270 ? 0.707 : 1}"></span>
      <span class="pmeta">
        <span class="no">${at + 1}</span>
        ${copy ? `<span class="hint">copy of ${slot.page + 1}</span>` : slot.page !== at ? `<span class="hint">was ${slot.page + 1}</span>` : ""}
        ${deg ? `<span class="rot">${deg}°</span>` : ""}
      </span>
      <!-- Their own row: a rotation badge appearing must not push a button onto a second line. -->
      <span class="pacts">
        <button class="spin" data-dup="${slot.id}" title="Duplicate this page">⧉</button>
        <button class="spin" data-rot="${slot.id}:-90" title="Turn left">↺</button>
        <button class="spin" data-rot="${slot.id}:90" title="Turn right">↻</button>
      </span>
    </li>`;
}

/**
 * Apply the edit, and say how it had to be done.
 *
 * Two paths, because the engine gives two shapes of answer and one of them is much cheaper:
 *
 * - **One extraction.** When every copy of a page shares one angle, the pages that need turning are
 *   turned on the source — each `rotatePage` a whole new document, so a second turn reopens the
 *   first one's output — and then a single `extractPages` takes the selection in order.
 * - **One document per page, merged.** When a page appears twice at different angles, no single
 *   document can hold both: `/Rotate` is a property of the page. So each kept slot is extracted
 *   from its own correctly-turned document and the results are merged in slot order.
 *
 * The second path is right rather than clever, and it is not free — a hundred slots are a few
 * hundred engine calls. That is why the first path is kept, and why the report says which ran.
 */
function applyEdit(doc, f) {
  const edit = editOf(f);
  const kept = keptSlots(edit);
  const indices = kept.map((slot) => slot.page);
  const at = performance.now();
  let calls = 0;

  // One angle per page, or more than one?
  const angle = new Map();
  let perSlot = false;
  for (const slot of kept) {
    if (angle.has(slot.page) && angle.get(slot.page) !== slot.deg) perSlot = true;
    angle.set(slot.page, slot.deg);
  }

  if (!perSlot) {
    let source = doc;
    let temp = null;
    try {
      for (const [page, deg] of angle) {
        if (!deg) continue;
        const next = source.rotatePage(page, deg);
        calls++;
        const reopened = Document.open(next);
        temp?.close();
        temp = reopened;
        source = reopened;
      }
      const report = source.extractPagesWithReport(indices);
      calls++;
      return { report, ms: performance.now() - at, calls, indices, how: "one extraction" };
    } finally {
      temp?.close();
    }
  }

  const parts = [];
  try {
    for (const slot of kept) {
      let source = doc;
      let temp = null;
      try {
        if (slot.deg) {
          temp = Document.open(doc.rotatePage(slot.page, slot.deg));
          calls++;
          source = temp;
        }
        parts.push(Document.open(source.extractPages([slot.page])));
        calls++;
      } finally {
        temp?.close();
      }
    }
    const report = mergeWithReport(parts);
    calls++;
    return {
      report,
      ms: performance.now() - at,
      calls,
      indices,
      how: "one document per page, merged",
    };
  } finally {
    // Every intermediate is a handle, and there is one per page here.
    for (const part of parts) part.close();
  }
}

const EFFECT_TAG = (effect) =>
  `<span class="tag ${effect === "preserved" ? "ok" : "warn"}">${effect}</span>`;

/** What a transform did to the parts of a document you cannot see. */
const reportCard = (title, report, extra = []) => `
  <dl class="kv" style="margin:12px 0 0">
    <dt>${esc(title)}</dt><dd><b>${kb(report.bytes.length)}</b></dd>
    <dt>Rewrite mode</dt><dd><span class="tag mono">${report.rewriteMode}</span></dd>
    <dt>Signatures</dt><dd>${EFFECT_TAG(report.signatureEffect)}</dd>
    <dt>Structure tree</dt><dd>${EFFECT_TAG(report.structureEffect)}</dd>
    ${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}
  </dl>`;

// --- Text --------------------------------------------------------------------------------------

function textPanel(doc, f) {
  const page = Math.min(state.page, doc.pageCount - 1);
  const positioned = state.positioned;
  const extract = timed(() =>
    attempt(() => (positioned ? doc.pageTextPositioned(page) : doc.pageText(page)), ""),
  );
  const body = extract.v ?? "";
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  return `
    ${readout([
      positioned ? "<b>pageTextPositioned</b>" : "<b>pageText</b>",
      `page ${page + 1} of ${doc.pageCount}`,
      `<b>${body.length}</b> characters, <b>${words}</b> words`,
      ms(extract.ms),
    ])}
    <div class="row">
      <button class="act ghost" id="tprev" ${page === 0 ? "disabled" : ""}>Previous</button>
      <label>Page <input type="number" id="pg" min="1" max="${doc.pageCount}" value="${page + 1}" style="width:5.5em" /></label>
      <button class="act ghost" id="tnext" ${page >= doc.pageCount - 1 ? "disabled" : ""}>Next</button>
      <label><input type="checkbox" id="pos" ${positioned ? "checked" : ""} /> preserve layout</label>
      <span class="grow"></span>
      <button class="act ghost" id="copytext" ${body ? "" : "disabled"}>Copy page</button>
      <button class="act ghost" id="alltext">Save all pages as .txt</button>
    </div>
    <p class="sub">${
      positioned
        ? "Positioned extraction takes line breaks and gaps from the text matrix, so columns survive."
        : "Reading-order extraction returns the text in content-stream order, one run per page."
    }</p>
    <pre>${body ? esc(body) : "<em>No extractable text on this page. A scan without an OCR layer has none — the picture is an image, and the Images panel will show it.</em>"}</pre>`;
}

// --- Find --------------------------------------------------------------------------------------

/**
 * Extract every page once, and keep it.
 *
 * Chunked, with a yield between slices, for one reason: the engine runs on this thread. A
 * thousand-page document extracted in one loop would freeze the tab for as long as it took, and
 * the demo would look like the engine's fault. Moving the engine to a worker is the real fix and is
 * written down in the demo's README as such.
 */
async function indexText(f, onProgress) {
  if (f.text) return f.text;
  const doc = f.doc;
  const pages = [];
  let engineMs = 0;
  for (let p = 0; p < f.pageCount; p++) {
    const got = timed(() => attempt(() => doc.pageText(p), ""));
    engineMs += got.ms;
    pages.push(got.v ?? "");
    if (p % 16 === 15) {
      onProgress?.(p + 1);
      await new Promise((r) => setTimeout(r));
      if (!f.doc) return null; // closed while we were indexing
    }
  }
  f.text = pages;
  f.textMs = engineMs;
  return pages;
}

const SNIPPET = 72;

function findHits(pages, query) {
  const needle = query.toLowerCase();
  const hits = [];
  let total = 0;
  for (const [page, body] of pages.entries()) {
    const haystack = body.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      total++;
      if (hits.length < 200) {
        const from = Math.max(0, at - SNIPPET);
        const to = Math.min(body.length, at + needle.length + SNIPPET);
        hits.push({
          page,
          before: (from > 0 ? "…" : "") + body.slice(from, at),
          match: body.slice(at, at + needle.length),
          after: body.slice(at + needle.length, to) + (to < body.length ? "…" : ""),
        });
      }
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return { hits, total };
}

function findPanel(doc, f) {
  return `
    <p class="readout" id="findreadout">${
      f.text
        ? `<span>indexed <b>${f.pageCount}</b> page${f.pageCount === 1 ? "" : "s"}</span><span>${ms(f.textMs)} of engine time</span><span>searching the cached text costs nothing</span>`
        : "<span>type to extract every page once, then search the result</span>"
    }</p>
    <div class="row">
      <input type="search" id="q" class="grow" placeholder="Find in this document" value="${esc(state.query)}"
             autocomplete="off" spellcheck="false" style="max-width:42em" />
    </div>
    <p class="sub">
      Prism extracts the text; the search is a plain substring match over what it returned. Every
      page is extracted once and kept, so the first search on a long document is the slow one.
    </p>
    <ul id="hits"></ul>`;
}

async function runFind(f) {
  const box = $("#hits");
  const line = $("#findreadout");
  const query = state.query.trim();
  if (!box) return;
  if (query.length < 2) {
    box.innerHTML = query ? `<p class="hint">Two characters or more.</p>` : "";
    return;
  }
  if (!f.text) {
    box.innerHTML = `<p class="hint">Extracting ${f.pageCount} pages…</p>`;
    const pages = await indexText(f, (done) => {
      if (box.isConnected) box.innerHTML = `<p class="hint">Extracting ${f.pageCount} pages — ${done} done…</p>`;
    });
    if (!pages || !box.isConnected) return;
    line.innerHTML =
      `<span>indexed <b>${f.pageCount}</b> page${f.pageCount === 1 ? "" : "s"}</span>` +
      `<span>${ms(f.textMs)} of engine time</span><span>searching the cached text costs nothing</span>`;
  }
  if (state.query.trim() !== query) return; // typed on while we were extracting
  const at = performance.now();
  const { hits, total } = findHits(f.text, query);
  const searchMs = performance.now() - at;
  line.innerHTML =
    `<span>indexed <b>${f.pageCount}</b> page${f.pageCount === 1 ? "" : "s"} in ${ms(f.textMs)}</span>` +
    `<span><b>${total}</b> match${total === 1 ? "" : "es"} for “${esc(query)}”</span>` +
    `<span>search ${ms(searchMs)}</span>`;
  box.innerHTML = total
    ? hits
        .map(
          (h) => `<li>
            <span class="where"><span>page ${h.page + 1}</span>
            <button class="act ghost tiny jump" data-jump="${h.page}">Show the page</button></span>
            <span class="snip">${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</span>
          </li>`,
        )
        .join("") + (total > hits.length ? `<p class="hint">Showing the first ${hits.length}.</p>` : "")
    : `<p class="hint">Nothing matches “${esc(query)}” in the extracted text. A scanned page without an OCR layer has no text to match.</p>`;
}

// --- Structure ---------------------------------------------------------------------------------

function structurePanel(doc) {
  const outline = timed(() => attempt(() => doc.outline(), []) ?? []);
  const fields = timed(() => attempt(() => doc.formFields(), []) ?? []);
  const cap = Math.min(doc.pageCount, 200);
  const scan = timed(() => {
    const found = [];
    let annots = 0;
    for (let p = 0; p < cap; p++) {
      for (const a of attempt(() => doc.pageAnnotations(p), []) ?? []) {
        annots++;
        found.push({ page: p, ...a });
      }
    }
    return { found, annots };
  });

  const links = scan.v.found.filter((a) => a.uri || a.destPage !== null);
  const tree = (items) =>
    `<ul class="tree">${items
      .map(
        (i) => `<li>
          <span class="row-i"><span class="t">${esc(i.title)}</span>${
            i.destPage !== null ? `<button class="jump" data-jump="${i.destPage}">page ${i.destPage + 1}</button>` : ""
          }</span>
          ${i.children.length ? tree(i.children) : ""}
        </li>`,
      )
      .join("")}</ul>`;

  let html = readout([
    `<b>${scan.v.annots}</b> annotation${scan.v.annots === 1 ? "" : "s"} over ${cap} page${cap === 1 ? "" : "s"} ${ms(scan.ms)}`,
    `outline ${ms(outline.ms)}`,
    `form fields ${ms(fields.ms)}`,
  ]);

  html += `<h2 class="panel-h">Outline</h2>`;
  html += outline.v.length
    ? tree(outline.v)
    : `<p class="sub">No bookmarks. The engine resolves each destination to a page index, and reports
       <code>null</code> for one that does not resolve.</p>`;

  html += `<h2 class="panel-h">Links and destinations</h2>`;
  html += links.length
    ? `<div class="scroll"><table><thead><tr><th class="num">Page</th><th>Kind</th><th>Target</th></tr></thead><tbody>${links
        .map(
          (l) => `<tr><td class="num">${l.page + 1}</td><td>${esc(l.subtype)}</td><td>${
            l.uri
              ? `<a href="${esc(l.uri)}" rel="noopener nofollow">${esc(l.uri)}</a>`
              : `<button class="jump" data-jump="${l.destPage}">page ${l.destPage + 1}</button>`
          }</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="sub">No links.</p>`;
  if (doc.pageCount > cap) html += `<p class="hint">Scanned the first ${cap} pages.</p>`;

  const noted = scan.v.found.filter((a) => a.contents);
  html += `<h2 class="panel-h">Annotations with a body</h2>`;
  html += noted.length
    ? `<div class="scroll"><table><thead><tr><th class="num">Page</th><th>Kind</th><th>Contents</th></tr></thead><tbody>${noted
        .map(
          (a) => `<tr><td class="num">${a.page + 1}</td><td>${esc(a.subtype)}</td><td>${esc(a.contents)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="sub">No note or accessibility text on any annotation.</p>`;

  html += `<h2 class="panel-h">Form fields</h2>`;
  html += fields.v.length
    ? `<div class="scroll"><table><thead><tr><th>Fully-qualified name</th><th>Type</th><th>Value</th></tr></thead><tbody>${fields.v
        .map(
          (field) => `<tr><td class="mono">${esc(field.name)}</td><td>${esc(field.fieldType || "—")}</td><td>${
            field.value === null ? "<em class='hint'>unset, or not textual</em>" : esc(field.value)
          }</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="sub">No AcroForm.</p>`;

  // A `Sig` field is a signature field, and the engine can see one — but it cannot tell you
  // whether it is valid. Verification needs a wall clock, WebAssembly has none, and pretending
  // otherwise would be worse than saying nothing: see `docs/wasm-constraints.md`.
  const sigs = fields.v.filter((field) => field.fieldType === "Sig").length;
  if (sigs) {
    html += `
      <div class="notice">
        <strong>${sigs} signature field${sigs === 1 ? "" : "s"} — not verified.</strong>
        This document has a <code>Sig</code> field, above, so it was signed by someone. Checking
        whether that signature is still valid needs a wall clock, and this binding runs in
        WebAssembly, which has none — <code>SystemTime::now()</code> traps rather than returning a
        time. That is an engine limit this page cannot work around, not one this page chose.
      </div>`;
  }
  return html;
}

// --- Fonts -------------------------------------------------------------------------------------
//
// The nicest loop on the page: Prism hands back the embedded font program, and the browser is asked
// to render a line of text with it. Nothing here parses the font — if the specimen draws, the bytes
// really are a working typeface.

const SPECIMEN = "Handgloves & 0123456789";
const PANGRAM = "The quick brown fox jumps over the lazy dog";

function fontsPanel(doc, f) {
  const got = timed(() => attempt(() => doc.fonts(), []) ?? []);
  const list = got.v.map((font, i) => ({ font, i }));
  if (!list.length) {
    return readout(["<b>fonts</b>", "<b>0</b> referenced", ms(got.ms)]) +
      `<p class="sub">This document references no fonts.</p>`;
  }

  const embedded = list.filter(({ font }) => font.embedded);
  const external = list.filter(({ font }) => !font.embedded);
  const bytes = embedded.reduce((n, { font }) => n + font.embedded.program.length, 0);

  let html = readout([
    `<b>${list.length}</b> font${list.length === 1 ? "" : "s"} referenced`,
    `<b>${embedded.length}</b> embedded, ${kb(bytes)} of programs`,
    ms(got.ms),
  ]);

  if (embedded.length) {
    html += `<h2 class="panel-h">Embedded programs</h2>
      <p class="sub">Each line below is drawn by your browser from the exact bytes the engine
      returned — a <code>FontFace</code> built over <code>font.embedded.program</code>, with nothing
      in between. If it draws, the program is a working typeface.</p>`;
    html += embedded
      .map(({ font, i }) => {
        const e = font.embedded;
        const facts = [
          `format <b>${esc(e.format)}</b>`,
          `program <b>${kb(e.program.length)}</b>`,
          e.metrics ? `units/em <b>${e.metrics.unitsPerEm}</b>` : null,
          e.metrics ? `glyphs <b>${e.metrics.glyphCount}</b>` : null,
          e.metrics?.familyName ? `family <b>${esc(e.metrics.familyName)}</b>` : "no sfnt metrics to parse",
        ].filter(Boolean);
        return `<div class="specimen">
          <div class="who">
            <span class="name">${esc(font.baseFont)}</span>
            <span class="tag">${esc(font.subtype)}</span>
            <span class="tag ok">embedded</span>
            <span class="spacer"></span>
            <button class="act ghost tiny" data-font="${i}">Save the program</button>
          </div>
          <div class="draw" data-draw="${i}">${esc(SPECIMEN)}<span class="small">${esc(PANGRAM)}</span></div>
          <p class="facts">${facts.map((t) => `<span>${t}</span>`).join("")}</p>
          <p class="facts" data-say="${i}"></p>
        </div>`;
      })
      .join("");
  }

  if (!embedded.length) {
    html += `<p class="sub">Nothing in this document embeds a font program, so there is no specimen
      to draw. Anything exported from Word, InDesign, LaTeX or a browser's print dialogue will have
      one — drop one in and this panel renders the typeface out of the file.</p>`;
  }

  if (external.length) {
    html += `<h2 class="panel-h">Referenced, not embedded</h2>
      <p class="sub">The file depends on the reader having these faces — which is exactly what a
      PDF/A pre-flight reports on, and why <code>font.embedded</code> is <code>null</code> rather
      than a program with a flag beside it. There is nothing to draw a specimen from.</p>
      <div class="scroll"><table>
        <thead><tr><th>Base font</th><th>Subtype</th><th>What a reader does</th></tr></thead>
        <tbody>${external
          .map(
            ({ font }) => `<tr>
              <td class="mono">${esc(font.baseFont)}</td>
              <td>${esc(font.subtype)}</td>
              <td>${
                /^(Helvetica|Courier|Times|Symbol|ZapfDingbats)/i.test(font.baseFont)
                  ? "One of the Standard 14 — substituted from a metrically compatible face."
                  : "Substituted, and the substitute's metrics may not match."
              }</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>`;
  }
  return html;
}

/** Register each embedded program as a real font, and say plainly when that cannot be done. */
async function paintFonts(doc, f) {
  const list = attempt(() => doc.fonts(), []) ?? [];
  for (const [i, font] of list.entries()) {
    const draw = $(`[data-draw="${i}"]`);
    const say = $(`[data-say="${i}"]`);
    const e = font.embedded;
    if (!draw || !say || !e) continue;
    // Type1 and bare CFF are legitimate PDF font programs that no browser will load: a `FontFace`
    // wants an sfnt or a WOFF. Saying so beats a specimen that silently falls back.
    if (e.format === "Type1" || e.format === "Cff") {
      say.innerHTML = `<span>a bare ${esc(e.format)} program — valid in a PDF, and not a format a browser will load, so this line is your substitute face</span>`;
      continue;
    }
    const family = `prism-${f.id}-${i}`;
    try {
      const face = new FontFace(family, e.program.slice().buffer);
      await face.load();
      document.fonts.add(face);
      f.faces.push(face);
      if (!draw.isConnected) return;
      draw.style.fontFamily = `"${family}", var(--sans)`;
      say.innerHTML = `<span>drawn from the ${kb(e.program.length)} the engine returned</span>`;
    } catch (err) {
      say.innerHTML = `<span>your browser refused the program — ${esc(why(err))}</span>`;
    }
  }
}

// --- Images ------------------------------------------------------------------------------------

const IMAGE_CAP = 48;
const PIXEL_CAP = 12e6;

function imagesPanel(doc, f) {
  const all = state.imgAll;
  const page = Math.min(state.imgPage, doc.pageCount - 1);
  const got = timed(() => {
    const found = [];
    const from = all ? 0 : page;
    const to = all ? doc.pageCount : page + 1;
    for (let p = from; p < to && found.length < IMAGE_CAP; p++) {
      for (const im of attempt(() => doc.pageImages(p), []) ?? []) found.push({ page: p, im });
    }
    return found;
  });
  const list = got.v;
  const total = list.reduce((n, { im }) => n + im.data.length, 0);

  let html = readout([
    all ? `<b>pageImages</b> over every page` : `<b>pageImages</b> on page ${page + 1}`,
    `<b>${list.length}</b> image${list.length === 1 ? "" : "s"}`,
    `<b>${kb(total)}</b> of payload`,
    ms(got.ms),
  ]);

  html += `<div class="row">
    <button class="act ghost" id="iprev" ${all || page === 0 ? "disabled" : ""}>Previous</button>
    <label>Page <input type="number" id="ipg" min="1" max="${doc.pageCount}" value="${page + 1}"
           style="width:5.5em" ${all ? "disabled" : ""} /></label>
    <button class="act ghost" id="inext" ${all || page >= doc.pageCount - 1 ? "disabled" : ""}>Next</button>
    <label><input type="checkbox" id="iall" ${all ? "checked" : ""} /> every page</label>
  </div>`;

  if (!list.length) {
    return (
      html +
      `<p class="sub">No image XObject in ${all ? "this document" : `page ${page + 1}`}'s resources.
       An image drawn by a pattern or a form XObject is not listed here.</p>`
    );
  }

  html += `<ul class="imgrid">${list
    .map(
      ({ page: p, im }, i) => `<li>
        <div class="frame" data-img="${i}" data-zoom="${i}" title="Show it full size"></div>
        <dl>
          <dt>size</dt><dd>${im.width}×${im.height}</dd>
          <dt>colour</dt><dd>${esc(im.colorSpace)}, ${im.components}×${im.bitsPerComponent} bpc</dd>
          <dt>payload</dt><dd>${esc(im.kind)}, ${kb(im.data.length)}</dd>
          ${state.imgAll ? `<dt>page</dt><dd>${p + 1}</dd>` : ""}
        </dl>
        <div class="acts"><button class="act ghost tiny" data-saveimg="${i}">Save</button></div>
      </li>`,
    )
    .join("")}</ul>
    <p class="sub" style="margin-top:14px">
      The engine returns decoded samples for a raw image and the original container for JPEG, JPEG
      2000 and JBIG2 — re-encoding someone else's photograph is not a PDF library's decision. This
      page draws the raw ones itself and hands a JPEG to the browser; a JPEG 2000 or JBIG2 payload
      is offered as a file, because there is no decoder here.
    </p>${list.length >= IMAGE_CAP ? `<p class="hint">Stopped at ${IMAGE_CAP} images.</p>` : ""}`;
  return html;
}

/**
 * Draw one image the way its payload allows.
 *
 * Returns an element, or a string saying why there is not one. The sample-walking below is the
 * whole reason `components` is on the type: it is the only way to size a row of an `Other` colour
 * space, and rows are padded to a byte boundary.
 */
function drawImage(im) {
  if (im.kind === "Jpeg") {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([im.data], { type: "image/jpeg" }));
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    img.alt = "";
    return img;
  }
  if (im.kind !== "Raw") return `A ${im.kind} payload. Save it and open it in something that decodes ${im.kind}.`;
  if (im.width * im.height > PIXEL_CAP) return `${im.width}×${im.height} is too large to draw here.`;
  if (im.colorSpace === "Other") {
    return `An Indexed, Separation or DeviceN space. The engine reports the samples and the component count; the palette needed to read them is not part of this API.`;
  }

  const { width: w, height: h, bitsPerComponent: bpc, components: n, data } = im;
  const max = (1 << bpc) - 1;
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  const sample = (row, col, comp) => {
    const index = col * n + comp;
    if (bpc === 8) return data[row * rowBytes + index];
    if (bpc === 16) return data[row * rowBytes + index * 2]; // the high byte is enough on screen
    const bit = index * bpc;
    const byte = data[row * rowBytes + (bit >> 3)];
    if (byte === undefined) return 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      const v = (comp) => (sample(y, x, comp) * 255) / max;
      if (im.colorSpace === "DeviceCmyk" && n >= 4) {
        const [c, m, ye, k] = [v(0) / 255, v(1) / 255, v(2) / 255, v(3) / 255];
        out.data[at] = 255 * (1 - Math.min(1, c + k));
        out.data[at + 1] = 255 * (1 - Math.min(1, m + k));
        out.data[at + 2] = 255 * (1 - Math.min(1, ye + k));
      } else if (n >= 3) {
        out.data[at] = v(0);
        out.data[at + 1] = v(1);
        out.data[at + 2] = v(2);
      } else {
        const g = v(0);
        out.data[at] = g;
        out.data[at + 1] = g;
        out.data[at + 2] = g;
      }
      out.data[at + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function currentImages(doc) {
  const all = state.imgAll;
  const page = Math.min(state.imgPage, doc.pageCount - 1);
  const found = [];
  const from = all ? 0 : page;
  const to = all ? doc.pageCount : page + 1;
  for (let p = from; p < to && found.length < IMAGE_CAP; p++) {
    for (const im of attempt(() => doc.pageImages(p), []) ?? []) found.push({ page: p, im });
  }
  return found;
}

function paintImages(doc) {
  for (const [i, { im }] of currentImages(doc).entries()) {
    const slot = $(`[data-img="${i}"]`);
    if (!slot) continue;
    const drawn = drawImage(im);
    if (typeof drawn === "string") {
      slot.style.cursor = "default";
      slot.removeAttribute("data-zoom");
      slot.innerHTML = `<p class="hint">${esc(drawn)}</p>`;
    } else {
      slot.replaceChildren(drawn);
    }
  }
}

const IMAGE_EXT = { Jpeg: "jpg", Jpeg2000: "jp2", Jbig2: "jbig2", Raw: "png" };

function saveImage(f, index, im) {
  const stem = `${baseName(f)}-image-${index + 1}`;
  if (im.kind === "Raw") {
    const drawn = drawImage(im);
    if (typeof drawn === "string") return toast(`That image cannot be written as a PNG here — ${drawn}`);
    drawn.toBlob((blob) => blob && saveBlob(blob, `${stem}.png`, "image/png"), "image/png");
    return;
  }
  saveBlob(im.data, `${stem}.${IMAGE_EXT[im.kind]}`, im.kind === "Jpeg" ? "image/jpeg" : "application/octet-stream");
}

function lightbox(im, caption) {
  const drawn = drawImage(im);
  if (typeof drawn === "string") return;
  // A 160×40 spectrum shown at 160×40 tells you nothing. Magnified, with pixelated rendering, you
  // are looking at the engine's decoded samples one square each — which is the point of the panel.
  drawn.style.width = `${Math.min(900, im.width * 8)}px`;
  drawn.style.height = "auto";
  const box = $("#lightbox");
  box.className = ""; // in case a page view left its own class behind
  const figure = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.innerHTML = `<span>${esc(caption)}</span><span class="hint">Click anywhere to close</span>`;
  figure.append(drawn, cap);
  box.replaceChildren(figure);
  box.hidden = false;
}

// --- Files (attachments) -----------------------------------------------------------------------

function attachmentsPanel(doc) {
  const got = timed(() => attempt(() => doc.attachments(), []) ?? []);
  const list = got.v;
  let html = readout([
    `<b>attachments</b>`,
    `<b>${list.length}</b> embedded file${list.length === 1 ? "" : "s"}`,
    `<b>${kb(list.reduce((n, a) => n + a.data.length, 0))}</b> decoded`,
    ms(got.ms),
  ]);
  if (!list.length) {
    return (
      html +
      `<p class="sub">No embedded files. They live in the catalogue's name tree (§7.11) rather than on
       a page, so a document can carry them without any page mentioning one.</p>`
    );
  }
  html += `<p class="sub">Decoded through the filter chain, in memory, in this tab. Saving one writes
    the bytes the engine returned.</p>
    <div class="scroll"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Relationship</th><th class="num">Size</th><th></th></tr></thead>
      <tbody>${list
        .map(
          (a, i) => `<tr>
            <td>${esc(a.name)}${a.description ? `<br /><span class="hint">${esc(a.description)}</span>` : ""}</td>
            <td class="mono">${a.mime ? esc(a.mime) : "—"}</td>
            <td>${a.relationship ? esc(a.relationship) : "—"}</td>
            <td class="num">${kb(a.data.length)}</td>
            <td><button class="act ghost tiny" data-att="${i}">Save</button></td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>`;
  return html;
}

// --- Writing the file out ----------------------------------------------------------------------

/** "1-3,5" over a 10-page document → [0,1,2,4]. One-based in, zero-based out. */
function parseRange(spec, pageCount) {
  const out = [];
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(t);
    if (!m) throw new Error(`cannot read "${t}" as a page or range`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) throw new Error(`"${t}" is not a valid range`);
    if (to > pageCount) throw new Error(`page ${to} is past the last page (${pageCount})`);
    for (let p = from; p <= to; p++) out.push(p - 1);
  }
  if (!out.length) throw new Error("no pages selected");
  return out;
}

function compareSizes(doc, f) {
  const modes = [
    ["Original", f.bytes, 0],
    ...[
      ["save() — classic cross-reference table", () => doc.save()],
      ["saveCompact() — cross-reference stream", () => doc.saveCompact()],
      ["savePacked() — object streams", () => doc.savePacked()],
    ].map(([label, call]) => {
      const got = timed(call);
      return [label, got.v, got.ms];
    }),
  ];
  const original = f.bytes.length;
  const widest = Math.max(...modes.map(([, b]) => b.length));
  const rows = modes
    .map(([label, bytes, took], i) => {
      const delta = i === 0 ? 0 : ((bytes.length - original) / original) * 100;
      const width = (bytes.length / widest) * 100;
      return `<tr>
        <td>${label}</td>
        <td class="num">${kb(bytes.length)}</td>
        <td class="barcell bartrack"><span class="sizebar ${i === 0 ? "base" : ""}" style="width:${width.toFixed(1)}%"></span></td>
        <td class="num ${i === 0 ? "" : `delta ${delta < 0 ? "down" : "up"}`}">${i === 0 ? "—" : pct(delta)}</td>
        <td class="num">${i === 0 ? "—" : dur(took)}</td>
        <td>${i === 0 ? "" : `<button class="act ghost tiny" data-save="${i}">Save</button>`}</td>
      </tr>`;
    })
    .join("");
  return {
    modes,
    html: `<div class="scroll" style="margin-top:12px"><table>
      <thead><tr><th>Mode</th><th class="num">Size</th><th>&nbsp;</th><th class="num">vs original</th><th class="num">Took</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  };
}

// --- the panel table ---------------------------------------------------------------------------

// The pencil beside "Pages" in the tab bar — same stroke style as the wordmark and the theme icons.
const EDIT_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="margin-right:4px;vertical-align:-1.5px">' +
  '<path d="M11.4 2.3 13.7 4.6 5.2 13.1 1.9 14.1 2.9 10.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>';

const PANELS = {
  overview: { label: "Overview", html: overviewPanel },
  // The one tab that changes the document — every other tab only ever reads it. `edits` drives the
  // divider and the pencil mark in the tab bar, so the split is drawn once rather than by name.
  pages: { label: "Pages", html: pagesPanel, paint: (doc, f) => watchThumbs(f), edits: true },
  text: { label: "Text", html: textPanel },
  find: {
    label: "Find",
    html: findPanel,
    paint: (doc, f) => {
      $("#q")?.focus();
      runFind(f);
    },
  },
  structure: { label: "Structure", html: structurePanel },
  fonts: { label: "Fonts", html: fontsPanel, paint: paintFonts, count: (f) => f.summary?.fonts },
  images: { label: "Images", html: imagesPanel, paint: paintImages },
  attachments: { label: "Files", html: attachmentsPanel, count: (f) => f.summary?.attachments },
};

// --- rendering ---------------------------------------------------------------------------------

function render() {
  const f = active();
  $("#handles").textContent = f?.doc ? "1 document handle open" : "";
  $("#footnote").textContent = f?.doc
    ? "Closing a file releases its handle."
    : "Nothing open. The engine is loaded and idle.";

  // The hero stays up when nothing is *open* — including the case where a file was chosen and the
  // engine refused it, where the hero itself carries the reason rather than a blank main area.
  $("#hero").hidden = Boolean(f?.doc);
  $("#ui").hidden = !f?.doc;
  $("#openerr").textContent = f?.error ? `${f.name} — ${f.error}` : "";
  if (!f?.doc) return;

  const doc = f.doc;
  $("#docname").textContent = f.name;
  const mode = doc.openReport.mode;
  $("#docfacts").innerHTML = [
    `<b>${doc.pageCount}</b> page${doc.pageCount === 1 ? "" : "s"}`,
    `<b>${kb(f.size)}</b>`,
    doc.version ? `PDF <b>${doc.version.major}.${doc.version.minor}</b>` : "no header version",
    mode === "recovered"
      ? `<span class="tag warn">recovered</span>`
      : `<span class="tag ok">strict</span>`,
    `opened in <b>${dur(f.openMs)}</b>`,
    `engine <b>${engineVersion()}</b>`,
  ]
    .map((s) => `<li>${s}</li>`)
    .join("");

  // A thin rule brackets the one tab that changes the document, so the tab bar itself says what
  // the panels otherwise leave to be discovered: everything either side of it only ever reads.
  const entries = Object.entries(PANELS);
  $("#tabs").innerHTML = entries
    .map(([id, panel], i) => {
      const n = panel.count?.(f);
      const sep = Boolean(panel.edits) !== Boolean(entries[i - 1]?.[1]?.edits);
      return `${i > 0 && sep ? '<span class="tabsep" aria-hidden="true"></span>' : ""}<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}"${
        panel.edits ? ' title="The only tab that changes the document"' : ""
      }>${panel.edits ? EDIT_ICON : ""}${panel.label}${n ? `<span class="count">${n}</span>` : ""}</button>`;
    })
    .join("");

  const panel = PANELS[state.tab] ?? PANELS.overview;
  const host = $("#panel");
  try {
    host.innerHTML = panel.html(doc, f);
  } catch (e) {
    host.innerHTML = `<p class="err">${esc(fail(e))}</p>`;
    return;
  }
  // Panels that need the DOM in place — a canvas to draw into, a font to register, an observer to
  // attach — do it here rather than in the string above.
  panel.paint?.(doc, f);
  wirePanel(doc, f);
}

/** Move to a page, in Text or Images — the two panels that page through the document by index. */
function goToPage(index) {
  const f = active();
  if (!f?.doc) return;
  const page = Math.min(Math.max(0, index), f.pageCount - 1);
  state.page = page;
  state.imgPage = page;
  render();
}

// --- panel wiring ------------------------------------------------------------------------------

function wirePanel(doc, f) {
  const on = (sel, ev, fn) => $(sel)?.addEventListener(ev, fn);
  const each = (sel, ev, fn) => $$(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));

  // --- overview
  on("#copyreport", "click", async () => {
    const { report, ms: took } = inspectionReport(doc, f);
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${kb(text.length)} of JSON — read in ${dur(took)}`);
    } catch {
      // Clipboard access can be refused; a file is the fallback that always works.
      saveBlob(text, `${baseName(f)}-report.json`, "application/json");
    }
  });

  // --- pages: the editor
  each("[data-view]", "click", (el) => openPageView(f, Number(el.dataset.view)));
  const rerender = () => render();
  const all = () => editOf(f).slots;
  on("#pickall", "click", () => {
    for (const slot of all()) slot.keep = true;
    rerender();
  });
  on("#pickinv", "click", () => {
    for (const slot of all()) slot.keep = !slot.keep;
    rerender();
  });
  on("#editreset", "click", () => {
    f.edit = null;
    rerender();
  });
  each("[data-keep]", "change", (el) => {
    const slot = all().find((s2) => s2.id === Number(el.dataset.keep));
    if (slot) slot.keep = el.checked;
    rerender();
  });
  each("[data-dup]", "click", (el) => {
    const edit = editOf(f);
    const at = edit.slots.findIndex((s2) => s2.id === Number(el.dataset.dup));
    if (at < 0) return;
    // A page can appear as often as you like — that is what `extractPages([0, 0])` means — so the
    // copy is a new slot over the same page, droppable and turnable on its own. It starts at the
    // angle it was copied from, because a copy of what you are looking at should look like it.
    edit.slots.splice(at + 1, 0, { ...edit.slots[at], id: edit.seq++, keep: true });
    rerender();
  });
  each("[data-rot]", "click", (el) => {
    const [id, by] = el.dataset.rot.split(":").map(Number);
    const slot = all().find((s2) => s2.id === id);
    if (!slot) return;
    slot.deg = ((((slot.deg + by) % 360) + 360) % 360);
    rerender();
  });
  // The text field selects; it does not export. One page range, one meaning.
  on("#dosplit", "click", () => {
    const out = $("#spliterr");
    out.textContent = "";
    try {
      const wanted = new Set(parseRange($("#range").value, f.pageCount));
      for (const slot of all()) slot.keep = wanted.has(slot.page);
      rerender();
    } catch (e) {
      out.textContent = e instanceof PrismPdfError ? fail(e) : e.message;
    }
  });
  on("#range", "keydown", (e) => {
    if (e.key === "Enter") $("#dosplit").click();
  });
  on("#doexport", "click", () => {
    const out = $("#exporterr");
    out.textContent = "";
    try {
      const { report, ms: took, calls, indices, how } = applyEdit(doc, f);
      download(report.bytes, `${baseName(f)}-edited.pdf`);
      $("#exportreport").innerHTML = reportCard(`${indices.length} pages written`, report, [
        [
          "Built by",
          `${how}${
            how.startsWith("one document per")
              ? ` <span class="hint">— <code>/Rotate</code> belongs to the page, so one page at two angles cannot share a document</span>`
              : ""
          }`,
        ],
        ["Engine calls", `<span class="mono">${calls}</span>`],
        ["Took", `<span class="mono">${dur(took)}</span>`],
        ["Order", `<span class="mono">${indices.map((i) => i + 1).join(", ")}</span>`],
      ]);
    } catch (e) {
      out.textContent = fail(e);
    }
  });
  on("#docompress", "click", () => {
    const box = $("#sizes");
    try {
      const { modes, html } = compareSizes(doc, f);
      box.innerHTML = html;
      for (const btn of box.querySelectorAll("[data-save]")) {
        btn.addEventListener("click", () => {
          const [label, bytes] = modes[Number(btn.dataset.save)];
          const suffix = label.startsWith("savePacked")
            ? "packed"
            : label.startsWith("saveCompact")
              ? "compact"
              : "saved";
          download(bytes, `${baseName(f)}-${suffix}.pdf`);
        });
      }
    } catch (e) {
      box.innerHTML = `<p class="err">${esc(fail(e))}</p>`;
    }
  });
  wirePageDrag(f);

  // --- text
  on("#pg", "change", (e) => {
    state.page = Math.max(0, Number(e.target.value) - 1);
    render();
  });
  on("#tprev", "click", () => {
    state.page = Math.max(0, state.page - 1);
    render();
  });
  on("#tnext", "click", () => {
    state.page = Math.min(f.pageCount - 1, state.page + 1);
    render();
  });
  on("#pos", "change", (e) => {
    state.positioned = e.target.checked;
    render();
  });
  on("#copytext", "click", async () => {
    const page = Math.min(state.page, doc.pageCount - 1);
    const body = attempt(() => (state.positioned ? doc.pageTextPositioned(page) : doc.pageText(page)), "");
    try {
      await navigator.clipboard.writeText(body ?? "");
      toast(`Copied page ${page + 1}`);
    } catch {
      toast("Your browser refused clipboard access.");
    }
  });
  on("#alltext", "click", () => {
    const got = timed(() => doc.text);
    saveBlob(got.v, `${baseName(f)}.txt`, "text/plain");
    toast(`Extracted ${f.pageCount} pages in ${dur(got.ms)}`);
  });

  // --- find
  let debounce = 0;
  on("#q", "input", (e) => {
    state.query = e.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => runFind(f), 180);
  });

  // --- fonts
  each("[data-font]", "click", (el) => {
    const font = doc.fonts()[Number(el.dataset.font)];
    const ext = { Type1: "pfb", TrueType: "ttf", Cff: "cff", OpenType: "otf" }[font.embedded.format];
    saveBlob(font.embedded.program, `${font.baseFont.replace(/[^\w.-]/g, "_")}.${ext}`, "font/otf");
  });

  // --- images
  on("#ipg", "change", (e) => {
    state.imgPage = Math.max(0, Number(e.target.value) - 1);
    render();
  });
  on("#iprev", "click", () => {
    state.imgPage = Math.max(0, state.imgPage - 1);
    render();
  });
  on("#inext", "click", () => {
    state.imgPage = Math.min(f.pageCount - 1, state.imgPage + 1);
    render();
  });
  on("#iall", "change", (e) => {
    state.imgAll = e.target.checked;
    render();
  });
  each("[data-zoom]", "click", (el) => {
    const found = currentImages(doc)[Number(el.dataset.zoom)];
    if (found) {
      lightbox(
        found.im,
        `${found.im.width}×${found.im.height} ${found.im.colorSpace} ${found.im.kind} on page ${found.page + 1}`,
      );
    }
  });
  each("[data-saveimg]", "click", (el) => {
    const i = Number(el.dataset.saveimg);
    const found = currentImages(doc)[i];
    if (found) saveImage(f, i, found.im);
  });

  // --- files
  each("[data-att]", "click", (el) => {
    const a = doc.attachments()[Number(el.dataset.att)];
    saveBlob(a.data, a.name, a.mime ?? "application/octet-stream");
  });

}

/** Drag one page card onto another to move it there. */
function wirePageDrag(f) {
  const grid = $("#pagegrid");
  if (!grid) return;
  let from = null;
  const at = (id) => editOf(f).slots.findIndex((slot) => slot.id === id);

  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-slot]");
    if (!card) return;
    from = Number(card.dataset.slot);
    card.classList.add("drag");
    e.dataTransfer.effectAllowed = "move";
    // Firefox will not start a drag without payload, and the payload is never read.
    e.dataTransfer.setData("text/plain", String(from));
  });
  grid.addEventListener("dragend", () => {
    from = null;
    for (const card of grid.querySelectorAll(".pcard")) card.classList.remove("drag", "over");
  });
  grid.addEventListener("dragover", (e) => {
    const card = e.target.closest("[data-slot]");
    if (from === null || !card) return;
    e.preventDefault();
    for (const other of grid.querySelectorAll(".over")) other.classList.remove("over");
    card.classList.add("over");
  });
  grid.addEventListener("drop", (e) => {
    const card = e.target.closest("[data-slot]");
    if (from === null || !card) return;
    e.preventDefault();
    const edit = editOf(f);
    const moved = at(from);
    const onto = at(Number(card.dataset.slot));
    if (moved === -1 || onto === -1 || moved === onto) return;
    edit.slots.splice(onto, 0, ...edit.slots.splice(moved, 1));
    render();
  });
}

// --- shell wiring ------------------------------------------------------------------------------

// "Show me that page" is offered by three panels, and the search results are written into the DOM
// after the panel was wired — so this one is delegated to the container that never goes away.
$("#panel").addEventListener("click", (e) => {
  const jump = e.target.closest("[data-jump]");
  if (jump) jumpToPage(Number(jump.dataset.jump));
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (!tab) return;
  state.tab = tab.dataset.tab;
  render();
});

$("#docclose").addEventListener("click", closeFile);

const picker = $("#picker");
const choose = () => picker.click();
$("#heroopen").addEventListener("click", choose);
$("#docopen").addEventListener("click", choose);
$("#herosample").addEventListener("click", openSample);
picker.addEventListener("change", () => {
  const file = picker.files[0];
  picker.value = "";
  if (file) openFile(file);
});

$("#theme").addEventListener("click", (e) => {
  const picked = e.target.closest("[data-theme-set]");
  // Clicking the segment already showing is not a no-op: it pins the theme that was until now
  // only a reading of the system setting.
  if (picked) applyTheme(picked.dataset.themeSet);
});

// A file dragged anywhere over the window is meant for this page, so the whole window is the target.
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  dragDepth++;
  $("#dragveil").hidden = false;
});
addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
});
addEventListener("dragleave", () => {
  if (--dragDepth > 0) return;
  dragDepth = 0;
  $("#dragveil").hidden = true;
});
addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dragveil").hidden = true;
  const files = [...e.dataTransfer.files].filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (!files.length) {
    toast("That is not a PDF. Nothing was opened.");
    return;
  }
  // One document at a time: the first PDF dropped wins, and dropping several is a mistake worth
  // saying something about rather than silently discarding the rest.
  openFile(files[0]);
  if (files.length > 1) toast(`Opened ${files[0].name} — only one document at a time, so the other ${files.length - 1} were not.`);
});

// The image lightbox closes on any click — it has nothing in it to click. The page viewer has a
// toolbar, so only the backdrop (or its own close button) may close it.
$("#lightbox").addEventListener("click", (e) => {
  const box = $("#lightbox");
  if (box.classList.contains("pageview") && e.target !== box && !e.target.closest("[data-close]")) return;
  if (box.classList.contains("pageview")) closePageView();
  else {
    box.hidden = true;
    box.replaceChildren();
  }
});

addEventListener("keydown", (e) => {
  const box = $("#lightbox");
  if (e.key === "Escape" && !box.hidden) {
    if (box.classList.contains("pageview")) closePageView();
    else {
      box.hidden = true;
      box.replaceChildren();
    }
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const f = active();
  if (!f?.doc) return;
  if (!box.hidden && box.classList.contains("pageview") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    stepPageView(f, e.key === "ArrowRight" ? 1 : -1);
    e.preventDefault();
    return;
  }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && (state.tab === "text" || state.tab === "images")) {
    const by = e.key === "ArrowRight" ? 1 : -1;
    const from = state.tab === "text" ? state.page : state.imgPage;
    goToPage(from + by);
    e.preventDefault();
  } else if (e.key === "/" || e.key === "f") {
    state.tab = "find";
    render();
    $("#q")?.focus();
    e.preventDefault();
  }
});

// --- boot --------------------------------------------------------------------------------------

try {
  applyTheme(localStorage.getItem("prism-demo-theme") ?? "system");
} catch {
  applyTheme("system");
}

// `init()` with no argument resolves the .wasm relative to the glue — which is what a consumer gets
// from a plain `await init()`, and the path this page exists to prove works on a static host.
const booted = timed(() => init());
await booted.v;
const bootMs = performance.now();

$("#ver").textContent = `engine ${engineVersion()}`;
$("#boot").textContent = `ready in ${dur(bootMs)}`;
// The module's transfer size, from the browser's own resource timing rather than a number typed
// into the page by hand.
const entry = performance.getEntriesByType("resource").find((r) => r.name.endsWith(".wasm"));
if (entry) $("#wasmsize").textContent = `${kb(entry.encodedBodySize || entry.decodedBodySize)} of wasm`;

render();
