//! Stamp the pinned engine tag into the binary so `engineVersion()` can report it.
//!
//! The native ABI answers this with `prismpdf_version()`, a static string compiled into
//! `pdf-ffi`. A wasm-bindgen shim has no such call to make — it links the facade crate, which
//! exports no version constant — so the tag is read here from `ENGINE_TAG` at the repository
//! root. That file is the single source of truth: `Cargo.toml`'s `tag = …`, this stamp, CI's
//! cache key and `docs/engine-source.md` all name the same release, and `build/check-tag.sh`
//! fails the build when they drift.

use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
        .join("../..")
        .join("ENGINE_TAG");
    println!("cargo:rerun-if-changed={}", root.display());

    let tag = fs::read_to_string(&root)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|error| {
            // Not a warning to be scrolled past: without the tag the package would report a
            // version it cannot substantiate, which is worse than not building.
            panic!("cannot read {}: {error}", root.display())
        });

    // `prismpdf_version()` equals the release tag without its `v` — a guarantee the engine's
    // release workflow enforces, and one the vertical slice asserts on. Strip the prefix here so
    // this binding reports the same string as every other.
    let version = tag.strip_prefix('v').unwrap_or(&tag);
    println!("cargo:rustc-env=PRISM_PDF_ENGINE_VERSION={version}");
}
