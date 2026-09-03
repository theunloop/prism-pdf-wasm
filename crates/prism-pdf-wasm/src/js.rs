//! Small helpers for building the plain JavaScript values the shim returns.
//!
//! Everything the read path produces crosses as an object literal or an array, never as an owned
//! `#[wasm_bindgen]` handle. That is the one structural deviation this binding makes from the
//! engine's `docs/BINDINGS.md` collection model, and `docs/naming.md` records why: list handles
//! and borrowed items exist because C has no vector and no lifetime, and neither problem exists
//! here. A JS array of plain objects has no disposal order to get wrong.

use wasm_bindgen::JsValue;

/// Build a JS object from `(key, value)` pairs.
pub fn obj(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let out = js_sys::Object::new();
    for (key, value) in entries {
        let _ = js_sys::Reflect::set(&out, &JsValue::from_str(key), &value);
    }
    out.into()
}

/// Build a JS array from an iterator of values.
pub fn arr(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    let out = js_sys::Array::new();
    for value in values {
        out.push(&value);
    }
    out.into()
}

/// `Option<String>` as a JS string or `null`.
///
/// Semantic contract 2: absence is the language's absence idiom, not an error. In JavaScript that
/// is `null` — chosen over `undefined` deliberately, because `undefined` is also what a *missing*
/// property reads as, and the two must stay distinguishable when a caller destructures a result.
pub fn text(value: Option<String>) -> JsValue {
    value.map_or(JsValue::NULL, |s| JsValue::from_str(&s))
}

/// `Option<T>` as a JS number or `null`.
pub fn num(value: Option<impl Into<f64>>) -> JsValue {
    value.map_or(JsValue::NULL, |n| JsValue::from_f64(n.into()))
}

/// Bytes as a `Uint8Array` copied into JavaScript's heap.
///
/// Semantic contract 5, "copy, then free, immediately". The copy is not optional: the alternative
/// is a view onto the wasm linear memory, which any later allocation may detach when the memory
/// grows, leaving the caller holding a zero-length array with no error to explain it.
pub fn bytes(value: &[u8]) -> JsValue {
    js_sys::Uint8Array::from(value).into()
}

/// A `[f64; 4]` rectangle as a four-element JS array.
pub fn rect(value: [f64; 4]) -> JsValue {
    arr(value.into_iter().map(JsValue::from_f64))
}
