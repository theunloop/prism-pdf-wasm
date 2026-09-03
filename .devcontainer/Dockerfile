# Node LTS on Debian bookworm, plus the Rust toolchain this binding compiles the engine with.
#
# Node is the base rather than Rust because that is the day-to-day loop: most changes are
# TypeScript, and the Rust half is rebuilt only when the shim changes.
ARG VARIANT=22-bookworm
FROM mcr.microsoft.com/devcontainers/javascript-node:${VARIANT}

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        # cargo shells out to cc to link; without this the build fails at the link step rather
        # than at compile time, which is a confusing way to find out.
        build-essential \
        pkg-config \
        # Day-to-day tooling.
        ripgrep \
        jq \
        less \
        vim \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Rust, installed directly rather than through the devcontainer feature: that feature also pulls
# lldb and llvm, hundreds of megabytes of debugger tooling for a toolchain this repository only
# invokes as `cargo build`. The minimal profile plus rust-src is enough for rust-analyzer.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal \
            --default-toolchain 1.90 \
            --component rust-src --component clippy --component rustfmt \
            --target wasm32-unknown-unknown \
    # The container runs as `node`, so cargo's registry cache and rustup's toolchains must be
    # writable by it, not only by root.
    && chmod -R a+rwX "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && rustc --version && cargo --version

# wasm-pack drives wasm-bindgen and wasm-opt. Installed from the release binary rather than
# `cargo install`, which builds it from source and takes several minutes for an identical result.
ARG WASM_PACK_VERSION=0.13.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) triple=x86_64-unknown-linux-musl ;; \
      arm64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-${triple}.tar.gz" \
      | tar xz -C /tmp; \
    install "/tmp/wasm-pack-v${WASM_PACK_VERSION}-${triple}/wasm-pack" /usr/local/bin/; \
    rm -rf /tmp/wasm-pack-*; \
    wasm-pack --version
