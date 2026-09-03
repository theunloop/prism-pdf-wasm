/**
 * The public API, minus the runtime-specific `init`.
 *
 * Both entry points re-export this, so the surface is identical on Node and in a browser.
 */

export { Document, merge, mergeWithReport } from "./document.js";
export { PrismPdfError, Status, statusName, type StatusCode } from "./errors.js";
export { isReady } from "./runtime.js";
export type {
  Annotation,
  Attachment,
  EmbeddedFont,
  Font,
  FontFormat,
  FontMetrics,
  FormField,
  Image,
  ImageColorSpace,
  ImageKind,
  Limits,
  OpenDiagnostic,
  OpenOptions,
  OpenReport,
  OutlineItem,
  PdfDate,
  RecoveryReason,
  RewriteMode,
  SignatureEffect,
  StructureEffect,
  TransformReport,
  Version,
} from "./types.js";

import { raw } from "./runtime.js";

/**
 * The engine release this package was built against, e.g. `"1.0.0-alpha.1"`.
 *
 * The engine guarantees this equals its release tag without the leading `v`, so it is safe to
 * assert on. It is the *engine* version, not this package's — the two move independently.
 */
export function engineVersion(): string {
  return raw().engineVersion();
}
