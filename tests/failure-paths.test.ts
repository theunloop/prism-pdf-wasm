/**
 * The failure-path journey, and the semantic contracts behind it.
 *
 * `docs/BINDINGS.md` lists what a binding must get right: a wrong password is a `Password` error
 * with a message; an absent optional field is absence, not an error; a disposed handle raises the
 * *wrapper's* error rather than crashing. Each contract is enforced in exactly one place in
 * `src/`, and each of those places has a case here — change one and this file is what tells you.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { Document, PrismPdfError, Status, init, isReady, statusName } from "../src/index.node.js";
import { CORPUS, SKIP_REASON, read } from "./corpus.js";

beforeAll(async () => {
  await init();
});

describe("the error type", () => {
  it("is one type, carrying the stable status", () => {
    const raised = capture(() => Document.open(new Uint8Array([1, 2, 3])));
    expect(raised).toBeInstanceOf(PrismPdfError);
    expect(raised).toBeInstanceOf(Error);
    expect(raised.name).toBe("PrismPdfError");
    // The status is the contract; the message is a diagnostic. Branch on the first, log the second.
    expect(typeof raised.status).toBe("number");
    expect(raised.message.length).toBeGreaterThan(0);
  });

  it("names its status codes", () => {
    expect(statusName(Status.Password)).toBe("Password");
    expect(statusName(Status.Parse)).toBe("Parse");
    // An unknown code must still render rather than come back `undefined`: the ABI is append-only,
    // so a newer engine may raise a status this package predates.
    expect(statusName(999)).toBe("Status(999)");
  });
});

describe("initialisation", () => {
  it("is idempotent and reports readiness", async () => {
    expect(isReady()).toBe(true);
    await expect(init()).resolves.toBeUndefined();
  });
});

describe.skipIf(CORPUS === null)("disposal", () => {
  it.skipIf(CORPUS !== null)(SKIP_REASON, () => {});

  it("raises the wrapper's error after close, not a crash", () => {
    const doc = Document.open(read("valid/two-pages-text.pdf"));
    expect(doc.closed).toBe(false);
    doc.close();
    expect(doc.closed).toBe(true);

    // The distinction that matters: this is *our* error, raised before the call reaches wasm.
    // Reaching wasm with a freed handle is how a binding turns a use-after-free into a trap.
    const raised = capture(() => doc.pageCount);
    expect(raised.status).toBe(Status.InvalidUse);
    expect(raised.message).toContain("closed");
  });

  it("is idempotent, so a finally block cannot double-free", () => {
    const doc = Document.open(read("valid/two-pages-text.pdf"));
    doc.close();
    expect(() => doc.close()).not.toThrow();
    expect(() => doc.close()).not.toThrow();
  });

  it("releases through `using`", () => {
    let escaped: Document;
    {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      escaped = doc;
      expect(doc.closed).toBe(false);
    }
    // The block ended, so `Symbol.dispose` ran.
    expect(escaped.closed).toBe(true);
  });

  it("closes every method, not just the one that checked", () => {
    const doc = Document.open(read("valid/two-pages-text.pdf"));
    doc.close();
    for (const call of [
      () => doc.pageText(0),
      () => doc.text,
      () => doc.fonts(),
      () => doc.outline(),
      () => doc.attachments(),
      () => doc.formFields(),
      () => doc.pageAnnotations(0),
      () => doc.pageImages(0),
      () => doc.xmp,
      () => doc.info("Title"),
      () => doc.save(),
      () => doc.saveCompact(),
      () => doc.savePacked(),
      () => doc.version,
      () => doc.minVersion,
      () => doc.openReport,
      () => doc.creationDate,
      () => doc.modificationDate,
    ]) {
      expect(capture(call).status).toBe(Status.InvalidUse);
    }
  });
});

describe.skipIf(CORPUS === null)("absence is not an error", () => {
  it("returns null for an optional field the document does not carry", () => {
    using doc = Document.open(read("valid/minimal-2page.pdf"));

    // This fixture carries /Title and /Author, so those prove the getter actually reads and
    // decodes rather than returning null for everything — which is the way this contract is
    // usually got wrong, and the way a test that only checked for null would never catch.
    expect(doc.info("Title")).toBe("Hello Prism PDF");
    expect(doc.info("Author")).toBe("Roberto");

    // The rest it does not carry. Absence, five times over, with nothing thrown.
    expect(doc.info("Subject")).toBeNull();
    expect(doc.info("Keywords")).toBeNull();
    expect(doc.xmp).toBeNull();
    expect(doc.creationDate).toBeNull();
    expect(doc.modificationDate).toBeNull();
  });

  it("returns null for a document with no /Info at all", () => {
    using doc = Document.open(read("valid/two-pages-text.pdf"));
    expect(doc.info("Title")).toBeNull();
  });

  it("but an out-of-range index is an error", () => {
    using doc = Document.open(read("valid/minimal-2page.pdf"));
    // The other half of `NotFound`. Absence of a *field* is null; absence of a *page* you asked
    // for by number is a mistake worth reporting.
    expect(capture(() => doc.pageText(doc.pageCount)).status).toBe(Status.NotFound);
  });
});

describe("open() argument handling", () => {
  it("refuses a combination the engine cannot yet express, rather than dropping one", () => {
    // `OpenOptions` — the engine handle that pairs a password with limits — is not bound in this
    // cut. Silently honouring one and discarding the other would be the worst outcome: a caller
    // would believe their DoS limits were applied to an encrypted upload.
    const raised = capture(() =>
      Document.open(new Uint8Array([0]), { password: "x", limits: { maxDepth: 4 } }),
    );
    expect(raised.status).toBe(Status.NullArgument);
    expect(raised.message).toContain("OpenOptions");
  });

  it.skipIf(CORPUS === null)("applies limits, and a limit that bites reports Parse", () => {
    const bytes = read("valid/objstm.pdf");
    // A depth of 1 cannot parse any real document; the point is that the limit reaches the engine
    // at all, which a positional-argument bug would silently break.
    const raised = capture(() => Document.open(bytes, { limits: { maxDepth: 1 } }));
    expect(raised.status).toBe(Status.Parse);

    // And the same file opens with the defaults, so the failure above is the limit and not the file.
    using doc = Document.open(bytes);
    expect(doc.pageCount).toBeGreaterThan(0);
  });
});

/**
 * The wrong-password path.
 *
 * `docs/BINDINGS.md` requires it, and it is not covered: the shared corpus ships no encrypted
 * fixture, and this cut binds the read path only, so the suite cannot write one either. It closes
 * when the security area lands and `saveEncrypted` can produce the fixture in-process — which is
 * how the .NET binding covers it. Recorded in CHANGELOG.md rather than left as a silent hole.
 */
describe.skipIf(true)("wrong password", () => {
  it("raises Password with a message", () => {});
});

function capture(call: () => unknown): PrismPdfError {
  try {
    call();
  } catch (raised) {
    if (raised instanceof PrismPdfError) return raised;
    throw raised;
  }
  throw new Error("expected a PrismPdfError, but the call succeeded");
}
