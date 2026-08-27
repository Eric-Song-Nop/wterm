/**
 * Low-level typed bindings to the ghostty-vt WASM module built from
 * our Zig export layer (zig/src/wasm_api.zig).
 *
 * Each exported Zig function maps 1:1 to a property on GhosttyExports.
 * This module handles WASM loading, memory management, and cell parsing.
 */

import {
  GHOSTTY_BUILD_ID,
  GHOSTTY_ENGINE_ID,
  GHOSTTY_ENGINE_MANIFEST,
  GHOSTTY_WASM_SHA256,
  type GhosttyEngineManifest,
} from "./engine.js";

export interface GhosttyExports {
  memory: WebAssembly.Memory;

  // Lifecycle
  init(
    cols: number,
    rows: number,
    max_scrollback: number,
    foreground_rgb: number,
    background_rgb: number,
    effects_mode: number,
  ): number;
  deinit(ptr: number): void;
  resize(
    ptr: number,
    cols: number,
    rows: number,
    width_px: number,
    height_px: number,
  ): number;

  // Data input
  write(ptr: number, data_ptr: number, data_len: number): number;

  // Engine and checkpoint data
  build_id_ptr(): number;
  build_id_len(): number;
  output_ptr(ptr: number): number;
  output_len(ptr: number): number;
  clear_output(ptr: number): void;
  export_continuation(ptr: number): number;
  encode_snapshot(ptr: number): number;

  // Semantic input encoding
  encode_key(
    ptr: number,
    key_ptr: number,
    key_len: number,
    text_ptr: number,
    text_len: number,
    modifiers: number,
    consumed_modifiers: number,
    action: number,
    composing: number,
    unshifted_codepoint: number,
  ): number;
  encode_paste(ptr: number, data_ptr: number, data_len: number): number;
  encode_focus(ptr: number, gained: number): number;

  // Render state
  update(ptr: number): number;
  get_viewport(ptr: number, buf_ptr: number, max_cells: number): number;
  get_viewport_grapheme(
    ptr: number,
    row: number,
    col: number,
    buf_ptr: number,
    buf_len: number,
  ): number;
  get_viewport_hyperlink(
    ptr: number,
    row: number,
    col: number,
    buf_ptr: number,
    buf_len: number,
  ): number;

  // Dirty tracking
  is_dirty(ptr: number): number;
  is_dirty_row(ptr: number, row: number): number;
  clear_dirty(ptr: number): void;

  // Cursor
  get_cursor_row(ptr: number): number;
  get_cursor_col(ptr: number): number;
  get_cursor_visible(ptr: number): number;

  // Modes
  cursor_keys_app(ptr: number): number;
  bracketed_paste(ptr: number): number;
  using_alt_screen(ptr: number): number;
  mouse_tracking(ptr: number): number;
  mouse_sgr(ptr: number): number;
  focus_events(ptr: number): number;
  synchronized_output(ptr: number): number;
  synchronized_output_generation(ptr: number): number;

  // Grid
  get_cols(ptr: number): number;
  get_rows(ptr: number): number;

  // Scrollback
  get_scrollback_count(ptr: number): number;
  get_scrollback_line(
    ptr: number,
    offset: number,
    buf_ptr: number,
    max_cols: number,
  ): number;
  get_scrollback_grapheme(
    ptr: number,
    offset: number,
    col: number,
    buf_ptr: number,
    buf_len: number,
  ): number;
  get_scrollback_hyperlink(
    ptr: number,
    offset: number,
    col: number,
    buf_ptr: number,
    buf_len: number,
  ): number;

  // PTY effects
  next_effect_len(ptr: number): number;
  read_effect(ptr: number, buf_ptr: number, buf_len: number): number;
  dropped_effect_frames(ptr: number): number;
  dropped_effect_bytes(ptr: number): number;
  read_response(ptr: number, buf_ptr: number, buf_len: number): number;

  // Memory
  alloc_buffer(len: number): number;
  free_buffer(ptr: number, len: number): void;
}

export interface GhosttyWasm {
  artifactVerified: boolean;
  exports: GhosttyExports;
  instance: WebAssembly.Instance;
}

export const WASM_MUTATION_STATUS = Object.freeze({
  ok: 0,
  semanticFailure: 1,
  effectOverflow: 2,
  resizeFailure: 3,
} as const);

export class GhosttyMutationError extends Error {
  readonly mutationCommitted: boolean;
  readonly fatal: boolean;

  constructor(
    readonly operation: string,
    readonly status: number,
    reason: string,
  ) {
    const mutationCommitted = status !== WASM_MUTATION_STATUS.resizeFailure;
    super(
      `@wterm/ghostty: ${operation} ${
        mutationCommitted
          ? "committed a fatal mutation and must not be retried"
          : "failed before mutation"
      }: ${reason}`,
    );
    this.name = "GhosttyMutationError";
    this.mutationCommitted = mutationCommitted;
    this.fatal = mutationCommitted;
  }
}

export class GhosttyRenderError extends Error {
  readonly fatal = true;

  constructor(reason: string) {
    super(`@wterm/ghostty: fatal render-state failure: ${reason}`);
    this.name = "GhosttyRenderError";
  }
}

export function assertMutationStatus(status: number, operation: string): void {
  if (status === WASM_MUTATION_STATUS.ok) return;
  const reason =
    status === WASM_MUTATION_STATUS.semanticFailure
      ? "Ghostty reported a terminal semantic failure"
      : status === WASM_MUTATION_STATUS.effectOverflow
        ? "the bounded PTY effect queue overflowed"
        : status === WASM_MUTATION_STATUS.resizeFailure
          ? "Ghostty rejected the resize"
          : `the WASM adapter returned status ${status}`;
  throw new GhosttyMutationError(operation, status, reason);
}

export type GhosttyWasmSource =
  | string
  | URL
  | BufferSource
  | WebAssembly.Module;

const CELL_BYTES = 16;

const REMEDY =
  "Serve the binary from your app and pass its URL: " +
  'GhosttyCore.load({ wasmPath: "/ghostty-vt.wasm" }). The file ships with ' +
  "the package as @wterm/ghostty/ghostty-vt.wasm. See the Bundlers section " +
  "of the @wterm/ghostty README.";
const NODE_FS_PROMISES: string = "node:fs/promises";

/**
 * Resolve the binary that ships with the package.
 *
 * Bundlers that implement the `new URL(..., import.meta.url)` asset pattern
 * rewrite this to an emitted asset. Ones that do not leave `import.meta.url`
 * pointing at the build machine's copy of this file.
 */
function defaultWasmUrl(): URL {
  return new URL("../wasm/ghostty-vt.wasm", import.meta.url);
}

/** `\0asm`. A 404 HTML page otherwise dies as "expected magic word". */
function asBytes(source: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

function hasWasmMagic(source: BufferSource): boolean {
  const bytes = asBytes(source);
  if (bytes.byteLength < 4) return false;
  const head = bytes.subarray(0, 4);
  return (
    head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d
  );
}

async function verifyWasmDigest(source: BufferSource): Promise<void> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "@wterm/ghostty: Web Crypto is required to verify the WASM artifact",
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(asBytes(source)),
  );
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== GHOSTTY_WASM_SHA256) {
    throw new Error(
      `@wterm/ghostty: WASM content mismatch: expected ${GHOSTTY_WASM_SHA256}, ` +
        `received ${actual}`,
    );
  }
}

function readBuildId(exports: GhosttyExports): string {
  if (
    typeof exports.build_id_ptr !== "function" ||
    typeof exports.build_id_len !== "function"
  ) {
    throw new Error(
      "@wterm/ghostty: the WASM adapter does not expose a build ID. " +
        "Rebuild it with the package's pinned Ghostty and Zig versions.",
    );
  }
  return new TextDecoder().decode(
    new Uint8Array(
      exports.memory.buffer,
      exports.build_id_ptr(),
      exports.build_id_len(),
    ),
  );
}

function isNodeRuntime(): boolean {
  return Boolean(
    (
      globalThis as typeof globalThis & {
        process?: { versions?: { node?: string } };
      }
    ).process?.versions?.node,
  );
}

async function readUrlBytes(source: string | URL): Promise<BufferSource> {
  if (
    String(source).startsWith("file:") &&
    isNodeRuntime() &&
    typeof document === "undefined"
  ) {
    const { readFile } = (await import(NODE_FS_PROMISES)) as {
      readFile(path: URL): Promise<Uint8Array>;
    };
    const file = await readFile(new URL(String(source)));
    const bytes = Uint8Array.from(file).buffer;
    if (!hasWasmMagic(bytes)) {
      throw new Error(`@wterm/ghostty: ${source} is not a WASM module`);
    }
    return bytes;
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(
      `@wterm/ghostty: fetching ${source} returned ${response.status} ` +
        `${response.statusText}. ${REMEDY}`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (!hasWasmMagic(bytes)) {
    throw new Error(
      `@wterm/ghostty: ${source} did not return a WASM module. ${REMEDY}`,
    );
  }
  return bytes;
}

/**
 * Load the ghostty-vt WASM module.
 *
 * @param source - URL, raw bytes, or a precompiled module. Defaults to the
 *   committed binary at `../wasm/ghostty-vt.wasm`.
 */
export async function loadGhosttyWasm(
  source?: GhosttyWasmSource,
): Promise<GhosttyWasm> {
  const resolved = source ?? defaultWasmUrl();

  // A file: URL in a browser is a build-machine path that survived bundling.
  // fetch() reports it as a bare "Failed to fetch", which names neither the
  // cause nor the fix.
  if (
    source === undefined &&
    String(resolved).startsWith("file:") &&
    typeof document !== "undefined"
  ) {
    throw new Error(
      `@wterm/ghostty: your bundler resolved the WASM URL to ${resolved}, a path ` +
        `on the machine that built the bundle, so the browser cannot fetch ` +
        `it. ${REMEDY}`,
    );
  }

  let module: WebAssembly.Module;
  let artifactVerified = false;
  if (resolved instanceof WebAssembly.Module) {
    module = resolved;
  } else {
    let bytes: BufferSource;
    if (typeof resolved === "string" || resolved instanceof URL) {
      bytes = await readUrlBytes(resolved);
    } else {
      bytes = resolved;
      if (!hasWasmMagic(bytes)) {
        throw new Error("@wterm/ghostty: the supplied bytes are not WASM");
      }
    }
    await verifyWasmDigest(bytes);
    artifactVerified = true;
    module = await WebAssembly.compile(bytes);
  }

  let wasmMemory: WebAssembly.Memory | undefined;

  const instance = await WebAssembly.instantiate(module, {
    env: {
      log(ptr: number, len: number) {
        if (!wasmMemory) return;
        const text = new TextDecoder().decode(
          new Uint8Array(wasmMemory.buffer, ptr, len),
        );
        console.log("[ghostty-vt]", text);
      },
    },
  });

  wasmMemory = instance.exports.memory as WebAssembly.Memory;
  const exports = instance.exports as unknown as GhosttyExports;
  const buildId = readBuildId(exports);
  if (buildId !== GHOSTTY_BUILD_ID) {
    throw new Error(
      `@wterm/ghostty: build mismatch: expected ${GHOSTTY_BUILD_ID}, ` +
        `received ${buildId}`,
    );
  }
  return { artifactVerified, exports, instance };
}

/** A loaded WASM instance shared by one or more terminal cores. */
export class GhosttyRuntime {
  readonly artifactVerified: boolean;
  readonly engineId = GHOSTTY_ENGINE_ID;
  readonly manifest: GhosttyEngineManifest = GHOSTTY_ENGINE_MANIFEST;

  private constructor(readonly wasm: GhosttyWasm) {
    this.artifactVerified = wasm.artifactVerified;
  }

  static async load(source?: GhosttyWasmSource): Promise<GhosttyRuntime> {
    return new GhosttyRuntime(await loadGhosttyWasm(source));
  }
}

/** Parsed cell data from the viewport buffer. */
export interface WasmCellData {
  codepoint: number;
  fgR: number;
  fgG: number;
  fgB: number;
  bgR: number;
  bgG: number;
  bgB: number;
  flags: number;
  width: number;
  /** Bit 0: has explicit fg color, Bit 1: has explicit bg color */
  colorFlags: number;
  hasGrapheme: boolean;
  hasHyperlink: boolean;
}

/**
 * Parse a single cell from the viewport buffer at the given byte offset.
 * The buffer layout matches the 16-byte struct from wasm_api.zig.
 */
export function parseCell(view: DataView, byteOffset: number): WasmCellData {
  return {
    codepoint: view.getUint32(byteOffset, true),
    fgR: view.getUint8(byteOffset + 4),
    fgG: view.getUint8(byteOffset + 5),
    fgB: view.getUint8(byteOffset + 6),
    bgR: view.getUint8(byteOffset + 7),
    bgG: view.getUint8(byteOffset + 8),
    bgB: view.getUint8(byteOffset + 9),
    flags: view.getUint8(byteOffset + 10),
    width: view.getUint8(byteOffset + 11),
    colorFlags: view.getUint8(byteOffset + 12),
    hasGrapheme: (view.getUint8(byteOffset + 13) & 1) !== 0,
    hasHyperlink: (view.getUint8(byteOffset + 13) & 2) !== 0,
  };
}

/** Byte size of one cell in the viewport buffer. */
export { CELL_BYTES };

/**
 * Allocate a buffer in WASM memory and return its pointer.
 * The caller must free it with freeBuffer when done.
 */
export function allocBuffer(wasm: GhosttyWasm, size: number): number {
  return wasm.exports.alloc_buffer(size);
}

/** Free a buffer previously allocated with allocBuffer. */
export function freeBuffer(wasm: GhosttyWasm, ptr: number, size: number): void {
  wasm.exports.free_buffer(ptr, size);
}

/**
 * Write a UTF-8 string into WASM memory and call the terminal's write
 * function. Handles allocation/deallocation of the transfer buffer.
 */
export function writeString(
  wasm: GhosttyWasm,
  termPtr: number,
  str: string,
): void {
  const encoded = new TextEncoder().encode(str);
  writeBytes(wasm, termPtr, encoded);
}

/**
 * Write raw bytes into the terminal. Handles allocation/deallocation
 * of the transfer buffer.
 */
export function writeBytes(
  wasm: GhosttyWasm,
  termPtr: number,
  data: Uint8Array,
): void {
  if (data.length === 0) return;
  const bufPtr = allocBuffer(wasm, data.length);
  if (bufPtr === 0) {
    throw new Error("@wterm/ghostty: WASM transfer allocation failed");
  }
  let mutationStarted = false;
  let status: number = WASM_MUTATION_STATUS.ok;
  try {
    new Uint8Array(wasm.exports.memory.buffer, bufPtr, data.length).set(data);
    mutationStarted = true;
    try {
      status = wasm.exports.write(termPtr, bufPtr, data.length);
    } catch {
      throw new GhosttyMutationError(
        "terminal write",
        -1,
        "the WASM adapter trapped with an unknown commit state",
      );
    }
  } finally {
    try {
      freeBuffer(wasm, bufPtr, data.length);
    } catch {
      if (mutationStarted) {
        throw new GhosttyMutationError(
          "terminal write",
          -1,
          "transfer-buffer cleanup trapped after the mutation started",
        );
      }
      throw new Error("@wterm/ghostty: WASM transfer-buffer cleanup trapped");
    }
  }
  assertMutationStatus(status, "terminal write");
}
