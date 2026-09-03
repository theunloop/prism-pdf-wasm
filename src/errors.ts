/**
 * One error type, carrying the stable status.
 *
 * Semantic contract 1 of the engine's `docs/BINDINGS.md`. Switch on {@link PrismPdfError.status},
 * never on the message: the status values are append-only and are never renumbered, while messages
 * are diagnostics and may change between engine releases.
 */

/**
 * The stable status codes, mirroring `PrismPdfStatus` in the engine's C ABI.
 *
 * A `const` object rather than a TypeScript `enum`: an `enum` emits a runtime value that cannot be
 * erased, which breaks `isolatedModules` consumers and anyone compiling with `verbatimModuleSyntax`.
 * The numbers are the contract and are copied from the engine's header.
 */
export const Status = {
  /** Success. Never carried by a thrown error. */
  Ok: 0,
  /** A required argument was missing, or a value was rejected. */
  NullArgument: 1,
  /** Unparseable, even after recovery. */
  Parse: 2,
  /**
   * The item does not exist.
   *
   * This one has two readings. On an *optional* getter absence is `null` and never throws; this
   * status means an *index* lookup went out of range, which is a caller mistake.
   */
  NotFound: 3,
  /** An internal error. */
  Internal: 4,
  /** Encrypted, and the supplied password is wrong or absent. */
  Password: 5,
  /** A conformance pass refused the document: nothing malformed, a standard's rule unmet. */
  Conformance: 6,
  /** A handle is closed, stale, or was already finalised. */
  InvalidUse: 7,
  /** Composition rejected geometry or could not paginate. */
  Layout: 8,
} as const;

/** One of the {@link Status} values. */
export type StatusCode = (typeof Status)[keyof typeof Status];

const STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Status).map(([name, value]) => [value, name]),
);

/** The name of a status code, for messages and logs. Unknown codes render as their number. */
export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `Status(${status})`;
}

/**
 * The single error every Prism PDF call raises.
 *
 * ```ts
 * try {
 *   using doc = Document.open(bytes);
 * } catch (e) {
 *   if (e instanceof PrismPdfError && e.status === Status.Password) {
 *     // Encrypted, and the password was wrong or absent. Retry with one.
 *   }
 * }
 * ```
 */
export class PrismPdfError extends Error {
  /** The stable status code. Branch on this. */
  readonly status: StatusCode;

  constructor(message: string, status: StatusCode) {
    super(message);
    this.name = "PrismPdfError";
    this.status = status;
    // Restores the prototype chain when this is compiled down to ES5, where extending a builtin
    // otherwise leaves `instanceof PrismPdfError` false.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The shape the Rust shim throws: a plain object, so nothing needs disposing in a catch block. */
interface RawError {
  __prismpdf: true;
  status: number;
  message: string;
}

function isRawError(value: unknown): value is RawError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RawError).__prismpdf === true &&
    typeof (value as RawError).status === "number"
  );
}

/**
 * Run a call into the shim, converting its structured failure into a {@link PrismPdfError}.
 *
 * Anything the shim did *not* raise deliberately is re-thrown untouched. That distinction matters:
 * a wasm trap, an out-of-memory, or a bug in the shim must not be dressed up as an engine status
 * a caller might then handle as though the document were merely malformed. See
 * `docs/wasm-constraints.md` for what a trap means here and why it is not recoverable.
 */
export function wrap<T>(call: () => T): T {
  try {
    return call();
  } catch (raised) {
    if (isRawError(raised)) {
      throw new PrismPdfError(raised.message, raised.status as StatusCode);
    }
    throw raised;
  }
}
