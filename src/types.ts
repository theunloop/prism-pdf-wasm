/**
 * The shapes the read path returns.
 *
 * These are plain objects and plain arrays — no handles, nothing to dispose. That is this
 * binding's one structural deviation from the engine's `docs/BINDINGS.md` collection model, and
 * `docs/naming.md` records the reasoning: list handles and borrowed items exist because C has
 * neither a vector nor a lifetime, and JavaScript has both.
 *
 * Field names are the C ABI's getter names in camelCase, so an `Annotation` here reads the same as
 * an `Annotation` in the .NET or Python binding.
 */

/** A PDF version number, as `%PDF-<major>.<minor>`. */
export interface Version {
  major: number;
  minor: number;
}

/** Why the strict open path fell back to rebuilding the cross-reference data. */
export type RecoveryReason = "xrefParseFailure" | "unreachableCatalog";

/** One bounded diagnostic recorded while opening. */
export interface OpenDiagnostic {
  reason: RecoveryReason;
  /** Input byte offset, when the reader supplied one. */
  offset: number | null;
}

/**
 * How a document opened.
 *
 * `"recovered"` means the cross-reference data was **rebuilt**, not that the parser was lenient.
 * A visibly broken file can still report `"strict"` — see `docs/conformance-suite.md`.
 */
export interface OpenReport {
  mode: "strict" | "recovered";
  /** At most two diagnostics are recorded. */
  diagnostics: OpenDiagnostic[];
}

/** An annotation (§12.5). */
export interface Annotation {
  /** `/Subtype` — `Link`, `Text`, `Widget`, `Highlight`, … */
  subtype: string;
  /** `/Rect` as `[llx, lly, urx, ury]` in default user space. */
  rect: [number, number, number, number];
  /** `/Contents` — a note's body, or accessibility text. */
  contents: string | null;
  /** The external URI of a link with a URI action (§12.6.4.7). */
  uri: string | null;
  /** The 0-based target page of an in-document link (§12.3.2). */
  destPage: number | null;
}

/** A terminal interactive form field (§12.7). */
export interface FormField {
  /** The fully-qualified name (§12.7.3.2), e.g. `"address.city"`. */
  name: string;
  /** `/FT` — `Tx`, `Btn`, `Ch`, `Sig`. Empty when it could not be determined. */
  fieldType: string;
  /** `/V` as text; `null` when unset or non-textual (a signature field, say). */
  value: string | null;
}

/** A bookmark (§12.3.3). Children nest to any depth. */
export interface OutlineItem {
  title: string;
  /** The 0-based destination page, or `null` when it does not resolve. */
  destPage: number | null;
  children: OutlineItem[];
}

/** An embedded file (§7.11), decoded through its filter chain. */
export interface Attachment {
  /** `/UF` if present, else `/F`, else the name-tree key. */
  name: string;
  data: Uint8Array;
  /** `/EmbeddedFile /Subtype`. */
  mime: string | null;
  /** `/AFRelationship` (§14.13). */
  relationship: string | null;
  /** `/Desc`. */
  description: string | null;
}

/** The format of an embedded font program (§9.9). */
export type FontFormat = "Type1" | "TrueType" | "Cff" | "OpenType";

/** Metrics parsed from an sfnt program. */
export interface FontMetrics {
  unitsPerEm: number;
  glyphCount: number;
  familyName: string | null;
}

/** An embedded font program. */
export interface EmbeddedFont {
  format: FontFormat;
  program: Uint8Array;
  /** Parsed metrics for TrueType/OpenType; `null` for Type1/CFF and unparseable programs. */
  metrics: FontMetrics | null;
}

/** A font the document's pages reference (§9.6, §9.8, §9.9). */
export interface Font {
  /** `/BaseFont`, often with a subset tag like `ABCDEF+`. */
  baseFont: string;
  /** `/Subtype` — `Type1`, `TrueType`, `Type0`, … */
  subtype: string;
  /**
   * The embedded program, or `null` when the font is referenced but not embedded.
   *
   * `null` here is the PDF/A pre-flight answer: an unembedded font is what
   * `ConformanceIssue.UnembeddedFont` reports on.
   */
  embedded: EmbeddedFont | null;
}

/** An image's colour space (§8.6). `Other` covers Indexed, Separation, DeviceN and the rest. */
export type ImageColorSpace = "DeviceGray" | "DeviceRgb" | "DeviceCmyk" | "Other";

/** How an image's payload is encoded. */
export type ImageKind = "Raw" | "Jpeg" | "Jpeg2000" | "Jbig2";

/** An image XObject drawn by a page (§8.9). */
export interface Image {
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: ImageColorSpace;
  /**
   * Components per sample. Needed to walk `Raw` bytes, and the only way to size an `Other` space.
   */
  components: number;
  kind: ImageKind;
  /** Decoded samples when `kind` is `"Raw"`; a complete container file otherwise. */
  data: Uint8Array;
}

/**
 * A date (§7.9.4).
 *
 * `utcOffsetMinutes` is `null` when the date declares no relationship to UTC, which §7.9.4
 * permits — that is genuinely "unknown", not "UTC".
 */
export interface PdfDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  utcOffsetMinutes: number | null;
}

/**
 * Anti-DoS limits (`DESIGN.md` §3.5). Every field is optional; an omitted one takes the engine's
 * default.
 *
 * `maxDecodedStream` is the one to reach for first in a browser: it is the decompression-bomb
 * guard, bounding what a single filter stage may expand to.
 */
export interface Limits {
  /** Maximum array/dictionary nesting depth. Default 512. */
  maxDepth?: number;
  /** Maximum objects in one object stream (`/N`, §7.5.7). */
  maxObjstmObjects?: number;
  /** Maximum cross-reference entries a document may declare. */
  maxObjects?: number;
  /** Maximum bytes one filter stage may decode to (§7.4). */
  maxDecodedStream?: number;
  /** Maximum stages in one stream's `/Filter` chain (§7.4). */
  maxFilterChain?: number;
}

/** Options for {@link Document.open}. */
export interface OpenOptions {
  /**
   * The password for an encrypted document (§7.6), tried as both user and owner. A string is
   * encoded as UTF-8.
   */
  password?: string | Uint8Array;
  /** Anti-DoS limits. */
  limits?: Limits;
}

/**
 * How a manipulation serialised its output.
 *
 * `"reconstructed"` is the one to read carefully: it means a *new* object graph was built from
 * selected source content, with fresh object identities — not that the file was rewritten in
 * place. Split and merge are both reconstructions.
 */
export type RewriteMode = "incremental" | "fullRewrite" | "reconstructed";

/** What a manipulation did to signatures already present in the source (§12.8). */
export type SignatureEffect = "preserved" | "invalidated" | "removed";

/** What a manipulation did to the source's logical structure tree (§14.7). */
export type StructureEffect = "preserved" | "invalidated" | "removed";

/**
 * The output of a manipulation, with its preservation effects stated rather than left to be
 * discovered.
 *
 * Every `…WithReport` call returns one. The plain call returns just the bytes and is the right
 * choice when you already know the answer — but "the signatures are gone" is not something a
 * caller should have to learn by reopening the output, which is why these exist.
 */
export interface TransformReport {
  /** The resulting PDF. */
  bytes: Uint8Array;
  rewriteMode: RewriteMode;
  signatureEffect: SignatureEffect;
  structureEffect: StructureEffect;
}
