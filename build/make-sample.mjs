// Write the demo's sample document.
//
// The demo needs one file it can open with no help from the visitor: a page whose every panel is
// empty until someone finds a PDF is a page most visitors leave. Nothing in the shared corpus is a
// candidate — those fixtures are deliberately minimal, and `CLAUDE.md` forbids copying them here
// anyway — so this script writes one, from nothing, at build time.
//
// It is written by hand rather than by a library for two reasons. The demo may not depend on a PDF
// *writer* to show off a PDF *reader*, and every feature the page has needs something to read:
// text in two typefaces, an outline that nests, a link that leaves the document and one that does
// not, two raw images in different colour spaces, a form field, an attachment, XMP, and a full
// /Info dictionary. Each of those is here because a panel would otherwise have nothing to say.
//
// Content streams are left uncompressed on purpose. It makes the file legible in a hex editor, and
// it leaves the demo's three save modes a real difference to report — they differ by a few per cent
// here, which is the honest answer for a file whose bulk is uncompressed image samples, and a more
// useful thing to show than the nothing you get from repacking an already-packed file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// --- a very small PDF writer -------------------------------------------------------------------

/** Objects are numbered in the order they are reserved, so a page can reference its own content. */
class Pdf {
  #bodies = []; // index 0 is object 1

  /** Reserve an object number without saying what is in it yet. */
  reserve() {
    this.#bodies.push(null);
    return this.#bodies.length;
  }

  /** Fill in a reserved object. `body` is everything between `obj` and `endobj`. */
  put(id, body) {
    this.#bodies[id - 1] = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    return id;
  }

  /** Reserve and fill in one step. */
  add(body) {
    return this.put(this.reserve(), body);
  }

  /** A stream object: a dictionary, then the bytes, with /Length filled in for you. */
  stream(dict, data) {
    const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    return Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`, "latin1"),
      bytes,
      Buffer.from("\nendstream", "latin1"),
    ]);
  }

  /**
   * Serialise, with a classic cross-reference table.
   *
   * A table rather than a cross-reference stream: this is the shape the engine's strict path reads
   * first, and keeping the sample in the older form means the demo's three save modes have
   * somewhere to go — `saveCompact()` is what turns it into a stream.
   */
  build(rootId, infoId) {
    const head = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
    const chunks = [head];
    let offset = head.length;
    const offsets = [];
    for (const [i, body] of this.#bodies.entries()) {
      if (!body) throw new Error(`object ${i + 1} was reserved and never filled in`);
      const obj = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
        body,
        Buffer.from("\nendobj\n", "latin1"),
      ]);
      offsets.push(offset);
      chunks.push(obj);
      offset += obj.length;
    }
    const n = this.#bodies.length;
    let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
    for (const at of offsets) xref += `${String(at).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${n + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\n`;
    xref += `startxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(chunks);
  }
}

// WinAnsiEncoding puts the typographic punctuation in the 0x80–0x9F range that Latin-1 leaves as
// control codes, so the characters this document actually wants — em dashes and curly quotes — need
// mapping by hand rather than by `charCodeAt`.
const WIN_ANSI = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** A PDF literal string, in WinAnsiEncoding. */
const str = (s) =>
  `(${[...s]
    .map((c) => {
      if (c === "(" || c === ")" || c === "\\") return `\\${c}`;
      if (WIN_ANSI[c]) return `\\${WIN_ANSI[c].toString(8).padStart(3, "0")}`;
      const code = c.codePointAt(0);
      // Anything past Latin-1 would need a composite font, which the sample deliberately has not
      // got. Nothing written below reaches for one; the guard is here so a later edit cannot
      // silently emit a byte that means something else.
      if (code > 255) throw new Error(`${JSON.stringify(c)} is not encodable in WinAnsiEncoding`);
      return c;
    })
    .join("")})`;

/**
 * A *text string* (§7.9.2.2) for a dictionary — a title, an author, a description.
 *
 * Pure ASCII goes out as a literal; anything else goes out as UTF-16BE behind a byte-order mark.
 * The alternative for the 0x80–0x9F range is PDFDocEncoding, which readers disagree about often
 * enough that an em dash in a document title is a genuine interoperability question. A BOM is not.
 * Content streams cannot use this — there the bytes are indices into the font's encoding, not text.
 */
const txt = (s) => {
  if (/^[\x20-\x7e]*$/.test(s)) return str(s);
  const utf16 = [0xfeff, ...s].map((c) => (typeof c === "number" ? c : c.codePointAt(0)));
  return `<${utf16.map((u) => u.toString(16).padStart(4, "0")).join("")}>`;
};

// --- page content ------------------------------------------------------------------------------

const PAGE = { w: 595.28, h: 841.89 }; // A4, in points
const M = 64; // margin

/** A text block: one `Tj` per line, so reading-order extraction returns the lines as written. */
function text(font, size, leading, x, y, lines) {
  const body = lines
    .map((line) => (line === "" ? "T*\n" : `${str(line)} Tj T*\n`))
    .join("");
  return `BT /${font} ${size} Tf ${leading} TL 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n${body}ET\n`;
}

/** A filled rule. The sample's only decoration, and it earns its place: it separates the columns. */
const rule = (x, y, w, h, gray) => `${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g\n`;

/** Place an image XObject at a rectangle, in its own graphics state. */
const place = (name, x, y, w, h) =>
  `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q\n`;

// --- the two images ----------------------------------------------------------------------------
//
// Both are raw samples rather than JPEG, because raw is the case the demo can draw itself: the
// engine hands back decoded bytes for `Raw` and the original container for everything else, and a
// page that can only show "JPEG payload — no decoder here" for its own sample file would be
// demonstrating the gap rather than the capability.

/** A spectrum: hue swept left to right, lightness top to bottom. 8 bits, DeviceRGB. */
function spectrum(w, h) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // A cosine palette — three phase-shifted cosines, which is enough to sweep the visible hues
      // without a hue-to-RGB conversion.
      const t = x / (w - 1);
      const lift = 0.18 + 0.72 * (1 - y / Math.max(1, h - 1));
      const rgb = [0, 2 / 3, 1 / 3].map((phase) =>
        Math.round(255 * lift * (0.5 + 0.5 * Math.cos(2 * Math.PI * (t + phase)))),
      );
      out.set(rgb, (y * w + x) * 3);
    }
  }
  return out;
}

/** A stepped grey ramp: 1 component, 8 bits, DeviceGray. */
function greyRamp(w, h, steps) {
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.round((255 * Math.floor((x / w) * steps)) / (steps - 1));
    }
  }
  return out;
}

// --- the document ------------------------------------------------------------------------------

const pdf = new Pdf();

const catalog = pdf.reserve();
const pagesId = pdf.reserve();
const pageIds = [pdf.reserve(), pdf.reserve(), pdf.reserve(), pdf.reserve()];

const helv = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
const bold = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
const times = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>");
const mono = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

const SPECTRUM = { w: 160, h: 40 };
const RAMP = { w: 96, h: 12, steps: 8 };
const imgSpectrum = pdf.add(
  pdf.stream(
    `/Type /XObject /Subtype /Image /Width ${SPECTRUM.w} /Height ${SPECTRUM.h}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8`,
    spectrum(SPECTRUM.w, SPECTRUM.h),
  ),
);
const imgRamp = pdf.add(
  pdf.stream(
    `/Type /XObject /Subtype /Image /Width ${RAMP.w} /Height ${RAMP.h}` +
      ` /ColorSpace /DeviceGray /BitsPerComponent 8`,
    greyRamp(RAMP.w, RAMP.h, RAMP.steps),
  ),
);

/**
 * Resources, per page, listing only the images that page draws.
 *
 * Worth the extra lines: `pageImages()` reads a page's resource dictionary, so a document that
 * declares both images on every page would have the demo's Images panel show two pictures on a
 * page that draws neither. A resource dictionary is a promise about what the content stream may
 * refer to, and this one keeps it.
 */
const resourcesFor = (xobjects) =>
  `<< /Font << /F1 ${helv} 0 R /F2 ${bold} 0 R /F3 ${times} 0 R /F4 ${mono} 0 R >>` +
  (xobjects.length
    ? ` /XObject << ${xobjects.map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >>`
    : "") +
  " >>";

const XOBJECTS = [
  [["Im1", imgSpectrum]],
  [["Im2", imgRamp]],
  [["Im1", imgSpectrum], ["Im2", imgRamp]],
  [],
];

// --- page 1: the cover -------------------------------------------------------------------------

const linkUri = pdf.add(
  `<< /Type /Annot /Subtype /Link /Rect [${M} 96 ${M + 250} 112] /Border [0 0 0]` +
    ` /A << /S /URI /URI ${txt("https://github.com/theunloop/prism-pdf-wasm")} >> >>`,
);

const content1 = pdf.add(
  pdf.stream(
    "",
    place("Im1", M, PAGE.h - 190, 320, 80) +
      text("F2", 34, 40, M, PAGE.h - 250, ["A sample document"]) +
      text("F1", 13, 20, M, PAGE.h - 286, [
        "Written from nothing by build/make-sample.mjs, so the demo has",
        "something to take apart before you hand it a file of your own.",
      ]) +
      rule(M, PAGE.h - 306, 320, 1.2, 0.75) +
      text("F1", 11, 17, M, PAGE.h - 340, [
        "Every panel on the page has something to read here:",
        "",
        "Four pages, two of them in a different typeface.",
        "An outline that nests two levels deep.",
        "A link that leaves this document, and one that stays inside it.",
        "Two images, in DeviceRGB and DeviceGray, stored as raw samples.",
        "A form field with a value, an attached text file, and an XMP packet.",
        "",
        "Nothing in this file is compressed. That is deliberate: it gives the",
        "three save modes an honest difference to report, not a rounding error.",
      ]) +
      text("F4", 10, 14, M, 100, ["github.com/theunloop/prism-pdf-wasm"]),
  ),
);

// --- page 2: how the reader is put together ----------------------------------------------------

const linkInternal = pdf.add(
  `<< /Type /Annot /Subtype /Link /Rect [${M} ${PAGE.h - 470} ${M + 190} ${PAGE.h - 454}]` +
    ` /Border [0 0 0] /Dest [${pageIds[3]} 0 R /Fit] >>`,
);

const content2 = pdf.add(
  pdf.stream(
    "",
    text("F2", 20, 26, M, PAGE.h - M - 20, ["Two layers, and only two"]) +
      rule(M, PAGE.h - M - 34, 200, 1.2, 0.75) +
      text("F3", 12, 19, M, PAGE.h - M - 76, [
        "Prism PDF is a pure-Rust PDF engine. What runs in this browser tab is that engine",
        "compiled to WebAssembly, wrapped twice: a mechanical Rust shim that owns handle",
        "lifetime and the status mapping, and a TypeScript layer where every ergonomic",
        "decision lives — options objects, defaults, null for absence, and one error type.",
        "",
        "The split is a cost decision. Rust is expensive to iterate on: a toolchain, a two",
        "minute build, and a wasm-opt pass at the end of it. TypeScript is a file save. So",
        "the Rust half stays as close to a projection of the engine as it can, and every",
        "judgement call is made where a judgement call is cheap to revise.",
        "",
        "What you cannot do here is anything that needs a clock. SystemTime::now() traps in",
        "a wasm runtime with no host bindings, and the engine reads it on the signing,",
        "verification and revocation paths — so this build has no security area at all. It",
        "is not an omission that was overlooked; it is one that is written down.",
      ]) +
      text("F1", 11, 17, M, PAGE.h - 454, ["Forms and attachments are on page four."]) +
      place("Im2", M, 120, 200, 25) +
      text("F4", 9, 12, M, 100, [`Im2: ${RAMP.w}x${RAMP.h} DeviceGray, ${RAMP.steps} steps, 8 bpc`]),
  ),
);

// --- page 3: what the images panel has to work with --------------------------------------------

const content3 = pdf.add(
  pdf.stream(
    "",
    text("F2", 20, 26, M, PAGE.h - M - 20, ["Images, as the engine hands them back"]) +
      rule(M, PAGE.h - M - 34, 200, 1.2, 0.75) +
      text("F3", 12, 19, M, PAGE.h - M - 76, [
        "The engine decodes a raw image through its filter chain and gives you the samples;",
        "for JPEG, JPEG 2000 and JBIG2 it gives you the container untouched, because",
        "re-encoding someone else's photograph is not a PDF library's decision to make.",
        "",
        "Both images in this file are raw, which is why the demo can draw them. A page of",
        "scanned JPEGs would show you their dimensions, colour space and byte count and",
        "leave the pixels to your browser.",
      ]) +
      place("Im1", M, PAGE.h - 470, 400, 100) +
      text("F4", 9, 12, M, PAGE.h - 486, [
        `Im1: ${SPECTRUM.w}x${SPECTRUM.h} DeviceRGB, 8 bpc, ${SPECTRUM.w * SPECTRUM.h * 3} bytes of samples`,
      ]) +
      place("Im2", M, PAGE.h - 560, 400, 40) +
      text("F4", 9, 12, M, PAGE.h - 576, [`Im2: the same grey ramp, stretched`]),
  ),
);

// --- page 4: forms, notes and the attachment ---------------------------------------------------

const fieldId = pdf.reserve();
const note = pdf.add(
  `<< /Type /Annot /Subtype /Text /Rect [${M} ${PAGE.h - 300} ${M + 20} ${PAGE.h - 280}]` +
    ` /Name /Comment /T ${txt("The demo")} /Contents ${txt(
      "An annotation with a body. The Structure panel lists it; the Text panel does not, because it is not page content.",
    )} >>`,
);

pdf.put(
  fieldId,
  `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${txt("reader.name")} /V ${txt("Ada Lovelace")}` +
    ` /Rect [${M} ${PAGE.h - 400} ${M + 220} ${PAGE.h - 376}] /F 4 /DA ${txt("/F1 11 Tf 0 g")}` +
    ` /MK << /BC [0.6 0.6 0.6] >> /P ${pageIds[3]} 0 R >>`,
);

const content4 = pdf.add(
  pdf.stream(
    "",
    text("F2", 20, 26, M, PAGE.h - M - 20, ["Forms, notes and attachments"]) +
      rule(M, PAGE.h - M - 34, 200, 1.2, 0.75) +
      text("F3", 12, 19, M, PAGE.h - M - 76, [
        "This page carries a text field, a sticky note, and the document carries an attached",
        "file. All three are structure rather than content: they are what the Structure and",
        "Files panels read, and none of them appears in extracted text.",
      ]) +
      text("F1", 10, 14, M, PAGE.h - 340, ["Field reader.name, with a value already set:"]) +
      text("F1", 10, 14, M, PAGE.h - 240, ["A note is anchored here."]),
  ),
);

// --- outline, attachment, metadata -------------------------------------------------------------

const outlineRoot = pdf.reserve();
const items = [
  ["A sample document", 0],
  ["Two layers, and only two", 1],
  ["Images, as the engine hands them back", 2],
  ["Forms, notes and attachments", 3],
];
const itemIds = items.map(() => pdf.reserve());
const childIds = [pdf.reserve(), pdf.reserve()];

itemIds.forEach((id, i) => {
  const parts = [
    `/Title ${txt(items[i][0])}`,
    `/Parent ${outlineRoot} 0 R`,
    `/Dest [${pageIds[items[i][1]]} 0 R /Fit]`,
  ];
  if (i > 0) parts.push(`/Prev ${itemIds[i - 1]} 0 R`);
  if (i < itemIds.length - 1) parts.push(`/Next ${itemIds[i + 1]} 0 R`);
  // The third heading nests, so the demo's outline tree has a level to indent.
  if (i === 2) {
    parts.push(`/First ${childIds[0]} 0 R`, `/Last ${childIds[1]} 0 R`, "/Count 2");
  }
  pdf.put(id, `<< ${parts.join(" ")} >>`);
});
pdf.put(
  childIds[0],
  `<< /Title ${txt("The spectrum, in DeviceRGB")} /Parent ${itemIds[2]} 0 R` +
    ` /Next ${childIds[1]} 0 R /Dest [${pageIds[2]} 0 R /Fit] >>`,
);
pdf.put(
  childIds[1],
  `<< /Title ${txt("The grey ramp, in DeviceGray")} /Parent ${itemIds[2]} 0 R` +
    ` /Prev ${childIds[0]} 0 R /Dest [${pageIds[2]} 0 R /Fit] >>`,
);
pdf.put(
  outlineRoot,
  `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds.at(-1)} 0 R /Count ${items.length + 2} >>`,
);

const ATTACHMENT = `Prism PDF — attached file
=========================

You are reading a file that was embedded inside the sample PDF and pulled back out
by the engine, in your browser, with nothing uploaded anywhere.

Attachments live in the document catalogue's name tree (§7.11), not on any page, so
they survive being extracted from a page range only if the page range keeps the
catalogue — which is why the demo reports, after every export, what the operation did
to the parts of a document you cannot see.
`;
const attachStream = pdf.add(
  pdf.stream(
    `/Type /EmbeddedFile /Subtype /text#2Fplain` +
      ` /Params << /Size ${Buffer.byteLength(ATTACHMENT)} >>`,
    Buffer.from(ATTACHMENT, "utf8"),
  ),
);
const filespec = pdf.add(
  `<< /Type /Filespec /F ${txt("about-attachments.txt")} /UF ${txt("about-attachments.txt")}` +
    ` /Desc ${txt("A text file embedded in the sample, so the Files panel has something to save.")}` +
    ` /AFRelationship /Supplement /EF << /F ${attachStream} 0 R >> >>`,
);
const names = pdf.add(
  `<< /EmbeddedFiles << /Names [${txt("about-attachments.txt")} ${filespec} 0 R] >> >>`,
);

const acroform = pdf.add(
  `<< /Fields [${fieldId} 0 R] /NeedAppearances true /DA ${txt("/F1 11 Tf 0 g")}` +
    ` /DR << /Font << /F1 ${helv} 0 R >> >> >>`,
);

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Prism PDF — a sample document</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>build/make-sample.mjs</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Written at build time so the demo has a document to open.</rdf:li></rdf:Alt></dc:description>
   <xmp:CreatorTool>build/make-sample.mjs</xmp:CreatorTool>
   <pdf:Producer>Prism PDF demo</pdf:Producer>
   <pdf:Keywords>pdf, webassembly, rust, sample</pdf:Keywords>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
const metadata = pdf.add(pdf.stream("/Type /Metadata /Subtype /XML", Buffer.from(XMP, "utf8")));

// A fixed date, so two builds of this file are byte-identical and a checksum means something.
const DATE = "D:20260101090000+01'00'";
const info = pdf.add(
  `<< /Title ${txt("Prism PDF — a sample document")} /Author ${txt("build/make-sample.mjs")}` +
    ` /Subject ${txt("Four pages written by hand so every panel of the demo has something to read")}` +
    ` /Keywords ${txt("pdf, webassembly, rust, sample")} /Creator ${txt("Prism PDF demo")}` +
    ` /Producer ${txt("build/make-sample.mjs — no PDF writer was involved")}` +
    ` /CreationDate (${DATE}) /ModDate (${DATE}) >>`,
);

const annots = [
  `[${linkUri} 0 R]`,
  `[${linkInternal} 0 R]`,
  "[]",
  `[${note} 0 R ${fieldId} 0 R]`,
];
const contents = [content1, content2, content3, content4];
pageIds.forEach((id, i) => {
  pdf.put(
    id,
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}]` +
      ` /Resources ${resourcesFor(XOBJECTS[i])} /Contents ${contents[i]} 0 R` +
      (annots[i] === "[]" ? "" : ` /Annots ${annots[i]}`) +
      " >>",
  );
});
pdf.put(
  pagesId,
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
);
pdf.put(
  catalog,
  `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` +
    ` /Names ${names} 0 R /AcroForm ${acroform} 0 R /Metadata ${metadata} 0 R /Lang (en-GB) >>`,
);

const out = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../_site/sample/prism-sample.pdf", import.meta.url)),
);
mkdirSync(dirname(out), { recursive: true });
const bytes = pdf.build(catalog, info);
writeFileSync(out, bytes);
console.log(`sample document: ${out} (${bytes.length} bytes, ${pageIds.length} pages)`);
