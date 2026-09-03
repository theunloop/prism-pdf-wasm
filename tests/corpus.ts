/**
 * Locating the engine's shared conformance corpus.
 *
 * The corpus is the engine's, published once per tag, and is not forked into this repository —
 * `docs/conformance-suite.md` explains why. A suite that cannot find it **skips with a message**
 * rather than failing: a contributor without it should still get a green run of everything that
 * does not need it. CI fails on any skip, which is where a missing corpus is a real problem.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function locate(): string | null {
  // 1. An explicit path always wins.
  const fromEnv = process.env.PRISMPDF_CORPUS;
  if (fromEnv && existsSync(join(fromEnv, "valid"))) return fromEnv;

  const candidates = [
    // 2. What `build/fetch-corpus.sh` writes.
    resolve(here, "../corpus"),
    // 3. An engine checkout beside this repository, for someone working on both at once.
    resolve(here, "../../prism-pdf/corpus"),
  ];
  return candidates.find((path) => existsSync(join(path, "valid"))) ?? null;
}

/** The corpus root, or `null` when it is not present. */
export const CORPUS = locate();

/**
 * Why the corpus is missing, phrased as something a reader can act on.
 *
 * Vitest prints a skip reason only if you give it one, and "skipped: 12" with no explanation is
 * how a suite quietly stops testing anything.
 */
export const SKIP_REASON =
  "shared corpus not found — run `npm run corpus`, set PRISMPDF_CORPUS, " +
  "or check out theunloop/prism-pdf beside this repository";

/** Read one corpus file, e.g. `read("valid/two-pages-text.pdf")`. */
export function read(relative: string): Uint8Array {
  if (CORPUS === null) throw new Error(SKIP_REASON);
  return new Uint8Array(readFileSync(join(CORPUS, relative)));
}

/** Whether one corpus file is present — a few fixtures exist only in some engine releases. */
export function has(relative: string): boolean {
  return CORPUS !== null && existsSync(join(CORPUS, relative));
}
