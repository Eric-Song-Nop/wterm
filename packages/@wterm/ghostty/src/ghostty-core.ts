import {
  TerminalInputModifier,
  terminalKeyEventFromDom,
  type TerminalDomKeyEvent,
  type TerminalKeyEvent,
  type TerminalMouseIntent,
  type CellData,
  type CursorState,
  type UnhandledSequence,
  type TerminalCore,
} from "@wterm/core";
import {
  type GhosttyWasm,
  type GhosttyWasmSource,
  GhosttyMutationError,
  GhosttyRenderError,
  WASM_MUTATION_STATUS,
  assertMutationStatus,
  loadGhosttyWasm,
  parseCell,
  writeString as wasmWriteString,
  writeBytes as wasmWriteBytes,
  allocBuffer,
  freeBuffer,
  CELL_BYTES,
} from "./wasm-bindings.js";
import type { GhosttyRuntime } from "./ghostty-runtime.js";

const DEFAULT_COLOR = 256;
const GRAPHEME_BUFFER_BYTES = 256;
const HYPERLINK_BUFFER_BYTES = 1024;
// WebAssembly i32 results are surfaced to JS as signed numbers.
const OUTPUT_ERROR = -1;
const MAX_PASTE_BYTES = 1024 * 1024;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const DEFAULT_FOREGROUND = "#d4d4d4";
const DEFAULT_BACKGROUND = "#1e1e1e";

const WTERM_FLAG_BOLD = 0x01;
const WTERM_FLAG_DIM = 0x02;
const WTERM_FLAG_ITALIC = 0x04;
const WTERM_FLAG_UNDERLINE = 0x08;
const WTERM_FLAG_BLINK = 0x10;
const WTERM_FLAG_REVERSE = 0x20;
const WTERM_FLAG_INVISIBLE = 0x40;
const WTERM_FLAG_STRIKETHROUGH = 0x80;

// Our WASM layer packs flags in the same order as wterm (see wasm_api.zig):
//   bold=1, faint=2, italic=4, underline=8, blink=16, inverse=32,
//   invisible=64, strikethrough=128
// This matches wterm's layout exactly, so no remapping is needed.
const _FLAG_SANITY_CHECK = [
  WTERM_FLAG_BOLD,
  WTERM_FLAG_DIM,
  WTERM_FLAG_ITALIC,
  WTERM_FLAG_UNDERLINE,
  WTERM_FLAG_BLINK,
  WTERM_FLAG_REVERSE,
  WTERM_FLAG_INVISIBLE,
  WTERM_FLAG_STRIKETHROUGH,
];
void _FLAG_SANITY_CHECK;

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

const BLANK_CELL: CellData = {
  char: 32,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  width: 1,
};

export interface GhosttyOptions {
  /** Preferred WASM input. Supports URLs, bytes, and precompiled modules. */
  wasmSource?: GhosttyWasmSource;
  /** @deprecated Use `wasmSource` for new integrations. */
  wasmPath?: string;
  scrollbackLimit?: number;
  foregroundColor?: string;
  backgroundColor?: string;
  effects?: "authority" | "discard";
}

export const GhosttyModifier = TerminalInputModifier;
export type GhosttyKeyEvent = Pick<TerminalKeyEvent, "key"> &
  Partial<Omit<TerminalKeyEvent, "key">>;
export type GhosttyDomKeyEvent = TerminalDomKeyEvent;
export type GhosttyNormalizedKeyEvent = TerminalKeyEvent;

export interface GhosttyEffectStats {
  droppedFrames: number;
  droppedBytes: number;
}

interface GridBufferAllocation {
  viewportPtr: number;
  viewportSize: number;
  scrollbackPtr: number;
  scrollbackSize: number;
}

const CHARACTER_KEYS: Readonly<Record<string, string>> = Object.freeze({
  " ": "space",
  "`": "backquote",
  "\\": "backslash",
  "[": "bracket_left",
  "]": "bracket_right",
  ",": "comma",
  "=": "equal",
  "-": "minus",
  ".": "period",
  "'": "quote",
  ";": "semicolon",
  "/": "slash",
});

/** Normalize the browser boundary once before a key crosses the wire. */
export function ghosttyKeyEventFromDom(
  event: GhosttyDomKeyEvent,
): GhosttyNormalizedKeyEvent {
  return terminalKeyEventFromDom(event);
}

function normalizeKeyName(value: string): string {
  const character = CHARACTER_KEYS[value];
  if (character) return character;
  if (/^[a-z]$/i.test(value)) return `key_${value.toLowerCase()}`;
  if (/^[0-9]$/.test(value)) return `digit_${value}`;
  if (/^Key[A-Z]$/.test(value)) return `key_${value.slice(3).toLowerCase()}`;
  if (/^Digit[0-9]$/.test(value)) return `digit_${value.slice(5)}`;
  if (/^Numpad[0-9]$/.test(value)) return `numpad_${value.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-5])$/.test(value)) return value.toLowerCase();
  if (value === "OSLeft") return "meta_left";
  if (value === "OSRight") return "meta_right";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[ -]+/g, "_")
    .toLowerCase();
}

function parseColor(value: string, option: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`@wterm/ghostty: ${option} must be a #RRGGBB color`);
  }
  return Number.parseInt(value.slice(1), 16);
}

/**
 * Terminal core powered by libghostty built from source. Implements the
 * same `TerminalCore` interface as wterm's built-in Zig core, providing
 * full-featured VT emulation including proper Unicode grapheme handling,
 * all SGR attributes, terminal modes, and more.
 *
 * @example
 * ```ts
 * import { WTerm } from '@wterm/dom';
 * import { GhosttyCore } from '@wterm/ghostty';
 *
 * const core = await GhosttyCore.load();
 * const term = new WTerm(el, { core });
 * await term.init();
 * ```
 */
export class GhosttyCore implements TerminalCore {
  private wasm: GhosttyWasm;
  private termPtr = 0;
  private _options: GhosttyOptions;
  private _foregroundRgb: number;
  private _backgroundRgb: number;
  private _disposed = false;
  private _poisoned = false;

  private _viewportBufPtr = 0;
  private _viewportBufSize = 0;
  private _viewportView: DataView | null = null;
  private _viewportStale = true;
  private _cols = 0;
  private _rows = 0;

  // One decoded scrollback row, reused across the per-column reads the
  // renderer does for that row.
  private _scrollbackBufPtr = 0;
  private _scrollbackBufSize = 0;
  private _scrollbackView: DataView | null = null;
  private _scrollbackOffset = -1;
  private _scrollbackLen = 0;
  private _graphemeBufPtr = 0;
  private _graphemeBufSize = GRAPHEME_BUFFER_BYTES;
  private _hyperlinkBufPtr = 0;
  private _hyperlinkBufSize = HYPERLINK_BUFFER_BYTES;

  private constructor(wasm: GhosttyWasm, options: GhosttyOptions) {
    this.wasm = wasm;
    this._options = options;
    this._foregroundRgb = parseColor(
      options.foregroundColor ?? DEFAULT_FOREGROUND,
      "foregroundColor",
    );
    this._backgroundRgb = parseColor(
      options.backgroundColor ?? DEFAULT_BACKGROUND,
      "backgroundColor",
    );
  }

  /**
   * Load the ghostty-vt WASM binary and create a new `GhosttyCore`.
   * The returned core is ready to be passed as the `core` option to `WTerm`.
   */
  static async load(options: GhosttyOptions = {}): Promise<GhosttyCore> {
    if (options.wasmSource !== undefined && options.wasmPath !== undefined) {
      throw new Error(
        "@wterm/ghostty: pass either wasmSource or wasmPath, not both",
      );
    }
    const wasm = await loadGhosttyWasm(options.wasmSource ?? options.wasmPath);
    return new GhosttyCore(wasm, options);
  }

  /** Create a core in an already-instantiated, reusable WASM runtime. */
  static fromRuntime(
    runtime: GhosttyRuntime,
    options: Omit<GhosttyOptions, "wasmSource" | "wasmPath"> = {},
  ): GhosttyCore {
    return new GhosttyCore(runtime.wasm, options);
  }

  /** @internal Transfer one passive-restore State into a fully owned core. */
  static _fromRestoredState(
    runtime: GhosttyRuntime,
    statePtr: number,
  ): GhosttyCore {
    const core = new GhosttyCore(runtime.wasm, { effects: "discard" });
    try {
      core._adoptRestoredState(statePtr);
      return core;
    } catch (error) {
      try {
        runtime.wasm.exports.deinit(statePtr);
      } catch {
        // Preserve the adoption error after best-effort State cleanup.
      }
      throw error;
    }
  }

  // -- Lifecycle --

  init(cols: number, rows: number): void {
    if (this._disposed) {
      throw new Error("@wterm/ghostty: cannot initialize a disposed core");
    }
    if (this.termPtr !== 0) {
      throw new Error("@wterm/ghostty: core is already initialized");
    }
    const scrollback = this._options.scrollbackLimit ?? 10000;
    if (
      !Number.isInteger(scrollback) ||
      scrollback < 0 ||
      scrollback > MAX_U32
    ) {
      throw new Error(
        "@wterm/ghostty: scrollbackLimit must be an unsigned 32-bit integer",
      );
    }

    let grid: GridBufferAllocation | undefined;
    let graphemePtr = 0;
    let hyperlinkPtr = 0;
    let termPtr = 0;
    try {
      grid = this._allocateGridBuffers(cols, rows);
      graphemePtr = this._allocateRequiredBuffer(
        GRAPHEME_BUFFER_BYTES,
        "grapheme",
      );
      hyperlinkPtr = this._allocateRequiredBuffer(
        HYPERLINK_BUFFER_BYTES,
        "hyperlink",
      );
      termPtr = this.wasm.exports.init(
        cols,
        rows,
        scrollback,
        this._foregroundRgb,
        this._backgroundRgb,
        this._options.effects === "discard" ? 0 : 1,
      );
      if (termPtr === 0) {
        throw new Error("@wterm/ghostty: failed to initialize the WASM core");
      }
    } catch (error) {
      if (termPtr !== 0) {
        try {
          this.wasm.exports.deinit(termPtr);
        } catch {
          // Preserve the initialization error after best-effort rollback.
        }
      }
      if (grid) this._releaseGridBuffers(grid);
      this._releaseBuffer(graphemePtr, GRAPHEME_BUFFER_BYTES);
      this._releaseBuffer(hyperlinkPtr, HYPERLINK_BUFFER_BYTES);
      throw error;
    }

    this.termPtr = termPtr;
    this._cols = cols;
    this._rows = rows;
    this._graphemeBufPtr = graphemePtr;
    this._graphemeBufSize = GRAPHEME_BUFFER_BYTES;
    this._hyperlinkBufPtr = hyperlinkPtr;
    this._hyperlinkBufSize = HYPERLINK_BUFFER_BYTES;
    this._installGridBuffers(grid);
    this._invalidate();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    try {
      this._releaseBuffer(this._viewportBufPtr, this._viewportBufSize);
      this._releaseBuffer(this._scrollbackBufPtr, this._scrollbackBufSize);
      this._releaseBuffer(this._graphemeBufPtr, this._graphemeBufSize);
      this._releaseBuffer(this._hyperlinkBufPtr, this._hyperlinkBufSize);
      if (this.termPtr !== 0) {
        try {
          this.wasm.exports.deinit(this.termPtr);
        } catch {
          // Disposal is best-effort so one trap cannot skip state cleanup.
        }
      }
    } finally {
      this.termPtr = 0;
      this._viewportBufPtr = 0;
      this._viewportBufSize = 0;
      this._viewportView = null;
      this._scrollbackBufPtr = 0;
      this._scrollbackBufSize = 0;
      this._scrollbackView = null;
      this._scrollbackOffset = -1;
      this._scrollbackLen = 0;
      this._graphemeBufPtr = 0;
      this._graphemeBufSize = 0;
      this._hyperlinkBufPtr = 0;
      this._hyperlinkBufSize = 0;
      this._cols = 0;
      this._rows = 0;
    }
  }

  resize(cols: number, rows: number, widthPx = 0, heightPx = 0): void {
    this._assertOperational();
    const grid = this._allocateGridBuffers(cols, rows);
    let status: number;
    try {
      status = this.wasm.exports.resize(
        this.termPtr,
        cols,
        rows,
        widthPx,
        heightPx,
      );
    } catch {
      this._releaseGridBuffers(grid);
      const error = new GhosttyMutationError(
        "terminal resize",
        -1,
        "the WASM adapter trapped with an unknown commit state",
      );
      this._recordMutationFailure(error);
      throw error;
    }
    if (
      status === WASM_MUTATION_STATUS.ok ||
      status === WASM_MUTATION_STATUS.effectOverflow
    ) {
      this._cols = cols;
      this._rows = rows;
      this._installGridBuffers(grid);
      this._invalidate();
    } else {
      this._releaseGridBuffers(grid);
    }
    try {
      assertMutationStatus(status, "terminal resize");
    } catch (error) {
      this._recordMutationFailure(error);
      throw error;
    }
  }

  // -- I/O --

  writeString(str: string): void {
    this._assertOperational();
    try {
      wasmWriteString(this.wasm, this.termPtr, str);
    } catch (error) {
      this._recordMutationFailure(error);
      throw error;
    } finally {
      // Ghostty may mutate before reporting a semantic or effect failure.
      this._invalidate();
    }
  }

  writeRaw(data: Uint8Array): void {
    this._assertOperational();
    try {
      wasmWriteBytes(this.wasm, this.termPtr, data);
    } catch (error) {
      this._recordMutationFailure(error);
      throw error;
    } finally {
      this._invalidate();
    }
  }

  /** Encode a semantic key against the authoritative terminal modes. */
  encodeKey(event: GhosttyKeyEvent): Uint8Array {
    this._assertOperational();
    const key = new TextEncoder().encode(
      normalizeKeyName(event.code || event.key),
    );
    const inferredText = Array.from(event.key).length === 1 ? event.key : "";
    const text = new TextEncoder().encode(event.text ?? inferredText);
    const altGraphMask = GhosttyModifier.Control | GhosttyModifier.Alt;
    const modifiers =
      (event.modifiers ?? 0) & (event.altGraph ? ~altGraphMask : 0xffff);
    const consumedModifiers =
      event.consumedModifiers ??
      (text.length > 0 ? modifiers & GhosttyModifier.Shift : 0);
    const action = event.action ?? (event.repeat ? "repeat" : "press");
    const actionRaw = action === "release" ? 0 : action === "press" ? 1 : 2;

    return this._withTransfer(key.length + text.length, (base) => {
      const memory = new Uint8Array(this.wasm.exports.memory.buffer);
      memory.set(key, base);
      memory.set(text, base + key.length);
      const len = this.wasm.exports.encode_key(
        this.termPtr,
        base,
        key.length,
        base + key.length,
        text.length,
        modifiers & 0xffff,
        consumedModifiers & modifiers & 0xffff,
        actionRaw,
        event.composing ? 1 : 0,
        event.unshiftedCodepoint ?? 0,
      );
      return this._copyOutput(len, "key encoding");
    });
  }

  /** Encode paste framing and sanitization from current terminal state. */
  encodePaste(data: Uint8Array | string): Uint8Array {
    this._assertOperational();
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length > MAX_PASTE_BYTES) {
      throw new Error(`@wterm/ghostty: paste exceeds ${MAX_PASTE_BYTES} bytes`);
    }
    return this._withTransfer(bytes.length, (ptr) => {
      if (bytes.length > 0) {
        new Uint8Array(this.wasm.exports.memory.buffer, ptr, bytes.length).set(
          bytes,
        );
      }
      return this._copyOutput(
        this.wasm.exports.encode_paste(this.termPtr, ptr, bytes.length),
        "paste encoding",
      );
    });
  }

  /** Encode a focus report when mode 1004 is enabled. */
  encodeFocus(focused: boolean): Uint8Array {
    this._assertOperational();
    return this._copyOutput(
      this.wasm.exports.encode_focus(this.termPtr, focused ? 1 : 0),
      "focus encoding",
    );
  }

  /** Encode pointer intent against authoritative mouse modes and geometry. */
  encodeMouse(event: TerminalMouseIntent): Uint8Array {
    this._assertOperational();
    if (
      event.action !== "press" &&
      event.action !== "release" &&
      event.action !== "move" &&
      event.action !== "wheel"
    ) {
      throw new Error("@wterm/ghostty: invalid mouse action");
    }
    if (
      !Number.isFinite(event.surface.x) ||
      !Number.isFinite(event.surface.y) ||
      !Number.isInteger(event.buttons) ||
      event.buttons < 0 ||
      event.buttons > 0b1_1111 ||
      !Number.isInteger(event.modifiers) ||
      event.modifiers < 0 ||
      event.modifiers > 0xffff
    ) {
      throw new Error("@wterm/ghostty: invalid mouse input");
    }
    if (event.action === "press" || event.action === "release") {
      if (
        !Number.isInteger(event.button) ||
        event.button === null ||
        event.button < 0 ||
        event.button > 4
      ) {
        throw new Error("@wterm/ghostty: invalid DOM mouse button");
      }
    } else if (event.button !== null) {
      throw new Error(
        "@wterm/ghostty: mouse move and wheel require a null button",
      );
    }

    let action: number;
    let button: number;
    if (event.action === "wheel") {
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new Error("@wterm/ghostty: invalid mouse wheel delta");
      }
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX === 0) return new Uint8Array();
        button = deltaX < 0 ? 6 : 7;
      } else {
        if (deltaY === 0) return new Uint8Array();
        button = deltaY < 0 ? 4 : 5;
      }
      action = 0;
    } else {
      action =
        event.action === "press" ? 0 : event.action === "release" ? 1 : 2;
      button = this._mouseButton(event);
    }

    return this._copyOutput(
      this.wasm.exports.encode_mouse(
        this.termPtr,
        action,
        button,
        event.buttons,
        event.modifiers,
        event.surface.x,
        event.surface.y,
      ),
      "mouse encoding",
    );
  }

  /** Encode a synchronous Ghostty binary checkpoint, including continuation. */
  encodeSnapshot(): Uint8Array {
    this._assertOperational();
    return this._copyOutput(
      this.wasm.exports.encode_snapshot(this.termPtr),
      "snapshot encoding",
    );
  }

  private _mouseButton(event: TerminalMouseIntent): number {
    const domButton =
      event.action === "move"
        ? event.buttons & 1
          ? 0
          : event.buttons & 4
            ? 1
            : event.buttons & 2
              ? 2
              : event.buttons & 8
                ? 3
                : event.buttons & 16
                  ? 4
                  : null
        : event.button;
    if (domButton === null) return 0;
    if (domButton === 0) return 1;
    if (domButton === 1) return 3;
    if (domButton === 2) return 2;
    // Xterm reserves buttons four through seven for wheel directions.
    if (domButton === 3) return 8;
    if (domButton === 4) return 9;
    throw new Error("@wterm/ghostty: unsupported DOM mouse button");
  }

  /** Export the exact replay-safe parser continuation retained by Ghostty. */
  getContinuation(): Uint8Array {
    this._assertOperational();
    return this._copyOutput(
      this.wasm.exports.export_continuation(this.termPtr),
      "continuation export",
    );
  }

  // -- Grid --

  getCell(row: number, col: number): CellData {
    this._ensureViewport();
    const view = this._viewportView;
    if (!view) return BLANK_CELL;

    const idx = row * this._cols + col;
    const byteOffset = idx * CELL_BYTES;
    if (byteOffset + CELL_BYTES > this._viewportBufSize) return BLANK_CELL;

    const cell = parseCell(view, byteOffset);
    // A continuation cell carries no content of its own, so the blank test
    // matches it. Returning BLANK_CELL would hide the width the renderer
    // needs to skip it.
    if (
      cell.codepoint === 0 &&
      cell.flags === 0 &&
      cell.colorFlags === 0 &&
      !cell.hasHyperlink &&
      cell.width !== 0
    )
      return BLANK_CELL;

    const result: CellData = {
      char: cell.codepoint || 32,
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
      flags: cell.flags,
      width: cell.width,
    };
    if (cell.hasGrapheme) result.chars = this._readGrapheme(row, col);
    if (cell.hasHyperlink)
      Object.assign(result, this._readHyperlink(row, col, false));
    if (cell.colorFlags & 1)
      result.fgRgb = packRgb(cell.fgR, cell.fgG, cell.fgB);
    if (cell.colorFlags & 2)
      result.bgRgb = packRgb(cell.bgR, cell.bgG, cell.bgB);
    return result;
  }

  isDirtyRow(row: number): boolean {
    this._ensureViewport();
    return this.wasm.exports.is_dirty_row(this.termPtr, row) !== 0;
  }

  clearDirty(): void {
    this._assertOperational();
    this.wasm.exports.clear_dirty(this.termPtr);
    this._viewportStale = true;
  }

  getCols(): number {
    return this._cols;
  }

  getRows(): number {
    return this._rows;
  }

  // -- Cursor --

  getCursor(): CursorState {
    this._ensureViewport();
    return {
      row: this.wasm.exports.get_cursor_row(this.termPtr),
      col: this.wasm.exports.get_cursor_col(this.termPtr),
      visible: this.wasm.exports.get_cursor_visible(this.termPtr) !== 0,
    };
  }

  // -- Modes --

  cursorKeysApp(): boolean {
    this._assertOperational();
    return this.wasm.exports.cursor_keys_app(this.termPtr) !== 0;
  }

  bracketedPaste(): boolean {
    this._assertOperational();
    return this.wasm.exports.bracketed_paste(this.termPtr) !== 0;
  }

  usingAltScreen(): boolean {
    this._assertOperational();
    return this.wasm.exports.using_alt_screen(this.termPtr) !== 0;
  }

  mouseTracking(): 0 | 9 | 1000 | 1002 | 1003 {
    this._assertOperational();
    const mode = this.wasm.exports.mouse_tracking(this.termPtr);
    return mode === 9 || mode === 1000 || mode === 1002 || mode === 1003
      ? mode
      : 0;
  }

  mouseSgr(): boolean {
    this._assertOperational();
    return this.wasm.exports.mouse_sgr(this.termPtr) !== 0;
  }

  focusEvents(): boolean {
    this._assertOperational();
    return this.wasm.exports.focus_events(this.termPtr) !== 0;
  }

  synchronizedOutput(): boolean {
    this._assertOperational();
    return this.wasm.exports.synchronized_output(this.termPtr) !== 0;
  }

  synchronizedOutputGeneration(): number {
    this._assertOperational();
    return this.wasm.exports.synchronized_output_generation(this.termPtr);
  }

  // -- Side outputs --

  getTitle(): string | null {
    // Title changes are not bridged into the current binary effect contract.
    return null;
  }

  getResponse(): string | null {
    this._assertInitialized();
    const effect = this._readEffect();
    return effect ? new TextDecoder().decode(effect) : null;
  }

  /** Drain copied WRITE_PTY effect frames in production order. */
  drainEffects(maxFrames = 256): Uint8Array[] {
    this._assertInitialized();
    if (!Number.isInteger(maxFrames) || maxFrames < 0 || maxFrames > 256) {
      throw new Error("@wterm/ghostty: maxFrames must be between 0 and 256");
    }
    const effects: Uint8Array[] = [];
    while (effects.length < maxFrames) {
      const effect = this._readEffect();
      if (!effect) break;
      effects.push(effect);
    }
    return effects;
  }

  getEffectStats(): GhosttyEffectStats {
    this._assertInitialized();
    return {
      droppedFrames:
        this.wasm.exports.dropped_effect_frames(this.termPtr) >>> 0,
      droppedBytes: this.wasm.exports.dropped_effect_bytes(this.termPtr) >>> 0,
    };
  }

  /** Fatal mutation failures poison the core so they cannot be retried. */
  isPoisoned(): boolean {
    return this._poisoned;
  }

  // -- Scrollback --

  getScrollbackCount(): number {
    this._assertOperational();
    return this.wasm.exports.get_scrollback_count(this.termPtr);
  }

  getScrollbackCell(offset: number, col: number): CellData {
    const len = this._ensureScrollbackLine(offset);
    const view = this._scrollbackView;
    if (!view || col >= len) return BLANK_CELL;

    const cell = parseCell(view, col * CELL_BYTES);
    const result: CellData = {
      char: cell.codepoint || 32,
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
      flags: cell.flags,
      width: cell.width,
    };
    if (cell.hasGrapheme)
      result.chars = this._readScrollbackGrapheme(offset, col);
    if (cell.hasHyperlink)
      Object.assign(result, this._readHyperlink(offset, col, true));
    if (cell.colorFlags & 1)
      result.fgRgb = packRgb(cell.fgR, cell.fgG, cell.fgB);
    if (cell.colorFlags & 2)
      result.bgRgb = packRgb(cell.bgR, cell.bgG, cell.bgB);
    return result;
  }

  getScrollbackLineLen(offset: number): number {
    return this._ensureScrollbackLine(offset);
  }

  // -- Debug --

  getUnhandledSequences(): UnhandledSequence[] {
    return [];
  }

  // -- Internal helpers --

  private _adoptRestoredState(statePtr: number): void {
    if (statePtr === 0) {
      throw new Error("@wterm/ghostty: passive restore returned no State");
    }
    const cols = this.wasm.exports.terminal_cols(statePtr);
    const rows = this.wasm.exports.terminal_rows(statePtr);
    let grid: GridBufferAllocation | undefined;
    let graphemePtr = 0;
    let hyperlinkPtr = 0;
    try {
      grid = this._allocateGridBuffers(cols, rows);
      graphemePtr = this._allocateRequiredBuffer(
        GRAPHEME_BUFFER_BYTES,
        "grapheme",
      );
      hyperlinkPtr = this._allocateRequiredBuffer(
        HYPERLINK_BUFFER_BYTES,
        "hyperlink",
      );
    } catch (error) {
      if (grid) this._releaseGridBuffers(grid);
      this._releaseBuffer(graphemePtr, GRAPHEME_BUFFER_BYTES);
      this._releaseBuffer(hyperlinkPtr, HYPERLINK_BUFFER_BYTES);
      throw error;
    }

    this.termPtr = statePtr;
    this._cols = cols;
    this._rows = rows;
    this._graphemeBufPtr = graphemePtr;
    this._graphemeBufSize = GRAPHEME_BUFFER_BYTES;
    this._hyperlinkBufPtr = hyperlinkPtr;
    this._hyperlinkBufSize = HYPERLINK_BUFFER_BYTES;
    this._installGridBuffers(grid);
    this._invalidate();
  }

  private _withTransfer<T>(
    byteLength: number,
    operation: (ptr: number) => T,
  ): T {
    const allocationSize = Math.max(1, byteLength);
    const ptr = allocBuffer(this.wasm, allocationSize);
    if (ptr === 0) {
      throw new Error("@wterm/ghostty: WASM transfer allocation failed");
    }
    try {
      return operation(ptr);
    } finally {
      freeBuffer(this.wasm, ptr, allocationSize);
    }
  }

  private _assertOperational(): void {
    this._assertInitialized();
    if (this._poisoned) {
      throw new Error(
        "@wterm/ghostty: core is poisoned after a fatal mutation; drain effects and terminate the session",
      );
    }
  }

  private _assertInitialized(): void {
    if (this._disposed) {
      throw new Error("@wterm/ghostty: core has been disposed");
    }
    if (this.termPtr === 0) {
      throw new Error("@wterm/ghostty: core is not initialized");
    }
  }

  private _recordMutationFailure(error: unknown): void {
    if (error instanceof GhosttyMutationError && error.fatal) {
      this._poisoned = true;
    }
  }

  private _copyOutput(len: number, operation: string): Uint8Array {
    try {
      if (len === OUTPUT_ERROR) {
        throw new Error(`@wterm/ghostty: ${operation} failed`);
      }
      if (this.wasm.exports.output_len(this.termPtr) !== len) {
        throw new Error(
          `@wterm/ghostty: ${operation} returned an invalid length`,
        );
      }
      if (len === 0) return new Uint8Array();
      const ptr = this.wasm.exports.output_ptr(this.termPtr);
      if (ptr === 0) {
        throw new Error(`@wterm/ghostty: ${operation} returned a null buffer`);
      }
      return new Uint8Array(this.wasm.exports.memory.buffer, ptr, len).slice();
    } finally {
      this.wasm.exports.clear_output(this.termPtr);
    }
  }

  private _readEffect(): Uint8Array | null {
    const len = this.wasm.exports.next_effect_len(this.termPtr);
    if (len === 0) return null;
    return this._withTransfer(len, (ptr) => {
      const written = this.wasm.exports.read_effect(this.termPtr, ptr, len);
      if (written !== len) {
        throw new Error("@wterm/ghostty: PTY effect queue read failed");
      }
      return new Uint8Array(this.wasm.exports.memory.buffer, ptr, len).slice();
    });
  }

  private _invalidate(): void {
    this._viewportStale = true;
    this._scrollbackOffset = -1;
  }

  private _decodeGrapheme(len: number): string | undefined {
    if (len === 0 || this._graphemeBufPtr === 0) return undefined;
    return new TextDecoder().decode(
      new Uint8Array(
        this.wasm.exports.memory.buffer,
        this._graphemeBufPtr,
        len,
      ),
    );
  }

  private _ensureGraphemeBuffer(required: number): void {
    if (required <= this._graphemeBufSize) return;
    const next = this._allocateRequiredBuffer(required, "grapheme");
    const previousPtr = this._graphemeBufPtr;
    const previousSize = this._graphemeBufSize;
    this._graphemeBufPtr = next;
    this._graphemeBufSize = required;
    this._releaseBuffer(previousPtr, previousSize);
  }

  private _ensureHyperlinkBuffer(required: number): void {
    if (required <= this._hyperlinkBufSize) return;
    const next = this._allocateRequiredBuffer(required, "hyperlink");
    const previousPtr = this._hyperlinkBufPtr;
    const previousSize = this._hyperlinkBufSize;
    this._hyperlinkBufPtr = next;
    this._hyperlinkBufSize = required;
    this._releaseBuffer(previousPtr, previousSize);
  }

  private _readHyperlink(
    rowOrOffset: number,
    col: number,
    scrollback: boolean,
  ): { linkUri: string; linkId?: string; linkKey: string } | undefined {
    if (this._hyperlinkBufPtr === 0) return undefined;
    const read = scrollback
      ? this.wasm.exports.get_scrollback_hyperlink
      : this.wasm.exports.get_viewport_hyperlink;
    let len = read(
      this.termPtr,
      rowOrOffset,
      col,
      this._hyperlinkBufPtr,
      this._hyperlinkBufSize,
    );
    if (len > this._hyperlinkBufSize) {
      this._ensureHyperlinkBuffer(len);
      if (this._hyperlinkBufPtr === 0) return undefined;
      len = read(
        this.termPtr,
        rowOrOffset,
        col,
        this._hyperlinkBufPtr,
        this._hyperlinkBufSize,
      );
    }
    if (len === 0 || len > this._hyperlinkBufSize) return undefined;
    const text = new TextDecoder().decode(
      new Uint8Array(
        this.wasm.exports.memory.buffer,
        this._hyperlinkBufPtr,
        len,
      ),
    );
    const [linkUri, linkId = "", implicitId = ""] = text.split("\0");
    if (!linkUri) return undefined;
    const linkKey = linkId
      ? `e\0${linkId}\0${linkUri}`
      : `g\0${implicitId}\0${linkUri}`;
    return {
      linkUri,
      linkId: linkId || undefined,
      linkKey,
    };
  }

  private _readGrapheme(row: number, col: number): string | undefined {
    if (this._graphemeBufPtr === 0 || !this.wasm.exports.get_viewport_grapheme)
      return undefined;
    let len = this.wasm.exports.get_viewport_grapheme(
      this.termPtr,
      row,
      col,
      this._graphemeBufPtr,
      this._graphemeBufSize,
    );
    if (len > this._graphemeBufSize) {
      this._ensureGraphemeBuffer(len);
      len = this.wasm.exports.get_viewport_grapheme(
        this.termPtr,
        row,
        col,
        this._graphemeBufPtr,
        this._graphemeBufSize,
      );
    }
    return this._decodeGrapheme(len);
  }

  private _readScrollbackGrapheme(
    offset: number,
    col: number,
  ): string | undefined {
    if (
      this._graphemeBufPtr === 0 ||
      !this.wasm.exports.get_scrollback_grapheme
    )
      return undefined;
    let len = this.wasm.exports.get_scrollback_grapheme(
      this.termPtr,
      offset,
      col,
      this._graphemeBufPtr,
      this._graphemeBufSize,
    );
    if (len > this._graphemeBufSize) {
      this._ensureGraphemeBuffer(len);
      len = this.wasm.exports.get_scrollback_grapheme(
        this.termPtr,
        offset,
        col,
        this._graphemeBufPtr,
        this._graphemeBufSize,
      );
    }
    return this._decodeGrapheme(len);
  }

  private _allocateRequiredBuffer(size: number, purpose: string): number {
    const ptr = allocBuffer(this.wasm, size);
    if (ptr === 0) {
      throw new Error(
        `@wterm/ghostty: failed to allocate the ${purpose} buffer`,
      );
    }
    return ptr;
  }

  private _allocateGridBuffers(
    cols: number,
    rows: number,
  ): GridBufferAllocation {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > MAX_U16 ||
      rows > MAX_U16
    ) {
      throw new Error(
        "@wterm/ghostty: terminal dimensions must be positive 16-bit integers",
      );
    }
    const viewportSize = cols * rows * CELL_BYTES;
    if (viewportSize > MAX_U32) {
      throw new Error("@wterm/ghostty: terminal viewport buffer is too large");
    }
    const scrollbackSize = cols * CELL_BYTES;
    const viewportPtr = this._allocateRequiredBuffer(viewportSize, "viewport");
    let scrollbackPtr = 0;
    try {
      scrollbackPtr = this._allocateRequiredBuffer(
        scrollbackSize,
        "scrollback",
      );
    } catch (error) {
      this._releaseBuffer(viewportPtr, viewportSize);
      throw error;
    }
    return { viewportPtr, viewportSize, scrollbackPtr, scrollbackSize };
  }

  private _installGridBuffers(next: GridBufferAllocation): void {
    const previous: GridBufferAllocation = {
      viewportPtr: this._viewportBufPtr,
      viewportSize: this._viewportBufSize,
      scrollbackPtr: this._scrollbackBufPtr,
      scrollbackSize: this._scrollbackBufSize,
    };
    this._viewportBufPtr = next.viewportPtr;
    this._viewportBufSize = next.viewportSize;
    this._viewportView = null;
    this._viewportStale = true;
    this._scrollbackBufPtr = next.scrollbackPtr;
    this._scrollbackBufSize = next.scrollbackSize;
    this._scrollbackView = null;
    this._scrollbackOffset = -1;
    this._scrollbackLen = 0;
    this._releaseGridBuffers(previous);
  }

  private _releaseGridBuffers(buffers: GridBufferAllocation): void {
    this._releaseBuffer(buffers.viewportPtr, buffers.viewportSize);
    this._releaseBuffer(buffers.scrollbackPtr, buffers.scrollbackSize);
  }

  private _releaseBuffer(ptr: number, size: number): void {
    if (ptr === 0) return;
    try {
      freeBuffer(this.wasm, ptr, size);
    } catch {
      // Best-effort release keeps the currently installed state usable.
    }
  }

  /**
   * Decode one scrollback row into the shared buffer, at most once per row
   * per invalidation, and return its length. The renderer reads a row column
   * by column, so without this each cell would cost a page-list walk.
   */
  private _ensureScrollbackLine(offset: number): number {
    this._assertOperational();
    if (this._scrollbackBufPtr === 0) return 0;

    if (this._scrollbackOffset !== offset) {
      this._scrollbackLen = this.wasm.exports.get_scrollback_line(
        this.termPtr,
        offset,
        this._scrollbackBufPtr,
        this._cols,
      );
      this._scrollbackOffset = offset;
    }

    // Growing WASM memory detaches the view, and a cached row outlives any
    // grow an unrelated read triggers in between, so check on hits too.
    if (this._scrollbackView?.buffer !== this.wasm.exports.memory.buffer) {
      this._scrollbackView = new DataView(
        this.wasm.exports.memory.buffer,
        this._scrollbackBufPtr,
        this._scrollbackBufSize,
      );
    }
    return this._scrollbackLen;
  }

  private _ensureViewport(): void {
    this._assertOperational();
    if (this._viewportStale) {
      let renderStatus: number;
      try {
        renderStatus = this.wasm.exports.update(this.termPtr);
      } catch {
        this._failRender("Ghostty trapped while updating RenderState");
      }
      if (renderStatus !== 0) {
        this._failRender("Ghostty could not update RenderState");
      }
      const expected = this._cols * this._rows;
      let written: number;
      try {
        written = this.wasm.exports.get_viewport(
          this.termPtr,
          this._viewportBufPtr,
          expected,
        );
      } catch {
        this._failRender("Ghostty trapped while exporting the viewport");
      }
      if (written !== expected) {
        this._failRender(
          `viewport export returned ${written} cells; expected ${expected}`,
        );
      }
      this._viewportStale = false;
    }
    if (this._viewportView?.buffer !== this.wasm.exports.memory.buffer) {
      this._viewportView = new DataView(
        this.wasm.exports.memory.buffer,
        this._viewportBufPtr,
        this._viewportBufSize,
      );
    }
  }

  private _failRender(reason: string): never {
    this._poisoned = true;
    throw new GhosttyRenderError(reason);
  }
}
