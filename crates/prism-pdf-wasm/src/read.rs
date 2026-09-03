//! The read path: annotations, form fields, outline, attachments, fonts, images, metadata.
//!
//! Each function turns one engine value into the plain JS shape `src/types.ts` declares. Field
//! names are the C ABI's getter names in camelCase — `prismpdf_annotation_dest_page` is
//! `destPage`, `prismpdf_form_field_type` is `fieldType` — so the shapes read the same as the
//! other bindings' item wrappers.

use prismpdf::{
    Annotation, ExtractedAttachment, FontProgramFormat, FormField, OutlineItem, RewriteMode,
    SignatureEffect, StructureEffect, TransformReport,
};
use wasm_bindgen::JsValue;

use crate::js::{arr, bytes, num, obj, rect, text};

pub fn annotation(a: &Annotation) -> JsValue {
    obj([
        ("subtype", JsValue::from_str(&a.subtype)),
        ("rect", rect(a.rect)),
        ("contents", text(a.contents.clone())),
        ("uri", text(a.uri.clone())),
        // `destPage` is 0-based, like every page index across the ABI.
        ("destPage", num(a.dest_page.map(|p| p as u32))),
    ])
}

pub fn form_field(f: &FormField) -> JsValue {
    obj([
        ("name", JsValue::from_str(&f.name)),
        // `/FT` — `Tx`, `Btn`, `Ch`, `Sig`; an empty string when the engine could not determine it,
        // which is what the ABI's `prismpdf_form_field_type` also reports.
        ("fieldType", JsValue::from_str(&f.field_type)),
        ("value", text(f.value.clone())),
    ])
}

/// The outline tree. The ABI lends nested children out of the root list's own allocation; here the
/// nesting is just nested arrays, so recursion needs no handle at any depth.
pub fn outline_item(item: &OutlineItem) -> JsValue {
    obj([
        ("title", JsValue::from_str(&item.title)),
        ("destPage", num(item.dest_page.map(|p| p as u32))),
        ("children", arr(item.children.iter().map(outline_item))),
    ])
}

pub fn attachment(a: &ExtractedAttachment) -> JsValue {
    obj([
        ("name", JsValue::from_str(&a.name)),
        ("data", bytes(&a.data)),
        ("mime", text(a.mime.clone())),
        ("relationship", text(a.relationship.clone())),
        ("description", text(a.description.clone())),
    ])
}

/// `FontProgramFormat` as its variant name.
///
/// Naming rule 9 says a `#[repr(C)]` enum becomes the language's native enum keeping its variant
/// names, and that the C integer values are the contract. JavaScript has no enum, so this binding
/// crosses the *names* and not the numbers: a name cannot be renumbered, and a string union is
/// what a TypeScript consumer can actually narrow on. `docs/naming.md` records the deviation.
fn font_format(format: FontProgramFormat) -> &'static str {
    match format {
        FontProgramFormat::Type1 => "Type1",
        FontProgramFormat::TrueType => "TrueType",
        FontProgramFormat::Cff => "Cff",
        FontProgramFormat::OpenType => "OpenType",
    }
}

pub fn font(f: &prismpdf::FontReport) -> JsValue {
    // `embedded` absent is the PDF/A pre-flight answer: the font is referenced but its program is
    // not in the file. The ABI reports it as `NotFound` from `prismpdf_font_program_format`, which
    // is absence rather than an error — so it is `null` here, not a throw.
    let embedded = f.embedded.as_ref().map_or(JsValue::NULL, |e| {
        let metrics = e.metrics.as_ref().map_or(JsValue::NULL, |m| {
            obj([
                ("unitsPerEm", JsValue::from_f64(f64::from(m.units_per_em))),
                ("glyphCount", JsValue::from_f64(f64::from(m.glyph_count))),
                ("familyName", text(m.family_name.clone())),
            ])
        });
        obj([
            ("format", JsValue::from_str(font_format(e.format))),
            ("program", bytes(&e.program)),
            ("metrics", metrics),
        ])
    });
    obj([
        ("baseFont", JsValue::from_str(&f.base_font)),
        ("subtype", JsValue::from_str(&f.subtype)),
        ("embedded", embedded),
    ])
}

pub fn image(img: &prismpdf::ExtractedImage) -> JsValue {
    use prismpdf::{ColorSpace, ImageData};

    // `Other` is every space the engine reduces to a component count (Indexed, Separation,
    // DeviceN, …). Its component count is the only way to walk `Raw` samples, so it crosses as a
    // separate field rather than being folded into the name.
    let space = match img.info.color_space {
        ColorSpace::DeviceGray => "DeviceGray",
        ColorSpace::DeviceRgb => "DeviceRgb",
        ColorSpace::DeviceCmyk => "DeviceCmyk",
        ColorSpace::Other(_) => "Other",
    };
    // `Raw` is decoded samples; every other kind is a complete container file the caller can hand
    // straight to an <img>, a Blob, or a decoder.
    let (kind, data) = match &img.data {
        ImageData::Raw(d) => ("Raw", d),
        ImageData::Jpeg(d) => ("Jpeg", d),
        ImageData::Jpeg2000(d) => ("Jpeg2000", d),
        ImageData::Jbig2(d) => ("Jbig2", d),
    };
    obj([
        ("width", JsValue::from_f64(f64::from(img.info.width))),
        ("height", JsValue::from_f64(f64::from(img.info.height))),
        (
            "bitsPerComponent",
            JsValue::from_f64(f64::from(img.info.bits_per_component)),
        ),
        ("colorSpace", JsValue::from_str(space)),
        (
            "components",
            JsValue::from_f64(f64::from(img.info.color_space.components())),
        ),
        ("kind", JsValue::from_str(kind)),
        ("data", bytes(data)),
    ])
}

/// A `PdfDate` (§7.9.4).
///
/// `utcOffsetMinutes` is `null` when the date declares no relationship to UTC, which §7.9.4
/// permits. The ABI splits that into a `has_utc_offset` flag beside a meaningless offset field
/// because C has no `Option`; JavaScript does, so the flag is not reproduced.
pub fn date(d: prismpdf::cos::PdfDate) -> JsValue {
    obj([
        ("year", JsValue::from_f64(f64::from(d.year))),
        ("month", JsValue::from_f64(f64::from(d.month))),
        ("day", JsValue::from_f64(f64::from(d.day))),
        ("hour", JsValue::from_f64(f64::from(d.hour))),
        ("minute", JsValue::from_f64(f64::from(d.minute))),
        ("second", JsValue::from_f64(f64::from(d.second))),
        ("utcOffsetMinutes", num(d.utc_offset_minutes)),
    ])
}

/// A `TransformReport`: the bytes a manipulation produced, plus what it did to the source's
/// signatures (§12.8) and logical structure tree (§14.7).
///
/// The engine states these effects rather than leaving them to be inferred, and that is the whole
/// point of the `*_with_report` variants — "your signatures are gone" is not something a caller
/// should have to discover by reopening the output.
///
/// The three enums cross as string unions, like every other engine enum here (deviation 2 in
/// `docs/naming.md`). They take the camelCase spelling of `OpenReport.mode` and `RecoveryReason`
/// rather than the PascalCase of `FontFormat`: those name PDF-domain types, where the exact
/// spelling is the PDF's own, while these name a mode or an outcome.
pub fn transform_report(r: &TransformReport) -> JsValue {
    let rewrite_mode = match r.rewrite_mode() {
        RewriteMode::Incremental => "incremental",
        RewriteMode::FullRewrite => "fullRewrite",
        RewriteMode::Reconstructed => "reconstructed",
    };
    let signature_effect = match r.signature_effect() {
        SignatureEffect::Preserved => "preserved",
        SignatureEffect::Invalidated => "invalidated",
        SignatureEffect::Removed => "removed",
    };
    let structure_effect = match r.structure_effect() {
        StructureEffect::Preserved => "preserved",
        StructureEffect::Invalidated => "invalidated",
        StructureEffect::Removed => "removed",
    };
    obj([
        ("bytes", bytes(r.bytes())),
        ("rewriteMode", JsValue::from_str(rewrite_mode)),
        ("signatureEffect", JsValue::from_str(signature_effect)),
        ("structureEffect", JsValue::from_str(structure_effect)),
    ])
}
