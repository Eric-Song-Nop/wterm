import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * getScrollbackCell() reads a single scrollback cell out of a WASM-owned
 * buffer written by get_scrollback_line(). We fake that buffer here so we
 * can exercise GhosttyCore's parsing logic without needing a real
 * ghostty-vt.wasm build (which loadGhosttyWasm() fetches over the network).
 */
const state = vi.hoisted(() => {
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    line: null as Uint8Array | null,
    lineLen: 0,
    deinit: vi.fn(),
    freeBuffer: vi.fn(),
    allocBuffer: vi.fn(() => 64),
    init: vi.fn(() => 1),
    resize: vi.fn(() => 0),
    write: vi.fn(() => 0),
    update: vi.fn(() => 0),
    getViewport: vi.fn(() => 80 * 24),
  };
});

vi.mock("../wasm-bindings.js", async () => {
  const actual = await vi.importActual<typeof import("../wasm-bindings.js")>(
    "../wasm-bindings.js",
  );

  const exports = {
    memory: state.memory,
    init: state.init,
    deinit: state.deinit,
    resize: state.resize,
    write: state.write,
    update: state.update,
    get_viewport: state.getViewport,
    // 0 is treated as an allocation failure by ghostty-core.ts, so the
    // fake pointer must be nonzero.
    alloc_buffer: state.allocBuffer,
    free_buffer: state.freeBuffer,
    get_scrollback_line: (
      _ptr: number,
      _offset: number,
      bufPtr: number,
      _maxCols: number,
    ) => {
      if (!state.line) return 0;
      new Uint8Array(state.memory.buffer, bufPtr, state.line.length).set(
        state.line,
      );
      return state.lineLen;
    },
    mouse_tracking: () => 1002,
    mouse_sgr: () => 1,
    focus_events: () => 1,
  };

  return {
    ...actual,
    loadGhosttyWasm: vi.fn(async () => ({
      artifactVerified: true,
      exports,
      instance: {} as WebAssembly.Instance,
    })),
  };
});

const { GhosttyCore } = await import("../ghostty-core.js");
const { CELL_BYTES } = await import("../wasm-bindings.js");

beforeEach(() => {
  state.allocBuffer.mockReset();
  state.allocBuffer.mockReturnValue(64);
  state.init.mockReset();
  state.init.mockReturnValue(1);
  state.resize.mockReset();
  state.resize.mockReturnValue(0);
  state.write.mockReset();
  state.write.mockReturnValue(0);
  state.update.mockReset();
  state.update.mockReturnValue(0);
  state.getViewport.mockReset();
  state.getViewport.mockReturnValue(80 * 24);
});

/** Build one raw scrollback cell matching the 16-byte wasm_api.zig layout. */
function buildCellBytes(opts: {
  codepoint: number;
  fgR?: number;
  fgG?: number;
  fgB?: number;
  bgR?: number;
  bgG?: number;
  bgB?: number;
  flags?: number;
  colorFlags: number;
}): Uint8Array {
  const buf = new ArrayBuffer(CELL_BYTES);
  const view = new DataView(buf);
  view.setUint32(0, opts.codepoint, true);
  view.setUint8(4, opts.fgR ?? 0);
  view.setUint8(5, opts.fgG ?? 0);
  view.setUint8(6, opts.fgB ?? 0);
  view.setUint8(7, opts.bgR ?? 0);
  view.setUint8(8, opts.bgG ?? 0);
  view.setUint8(9, opts.bgB ?? 0);
  view.setUint8(10, opts.flags ?? 0);
  view.setUint8(11, 1); // width
  view.setUint8(12, opts.colorFlags);
  return new Uint8Array(buf);
}

describe("GhosttyCore.getScrollbackCell", () => {
  beforeEach(() => {
    state.line = null;
    state.lineLen = 0;
  });

  it("does not set fgRgb/bgRgb when colorFlags === 0 (falls back to defaults)", async () => {
    state.line = buildCellBytes({ codepoint: 65, colorFlags: 0 });
    state.lineLen = 1;

    const core = await GhosttyCore.load();
    core.init(80, 24);
    const cell = core.getScrollbackCell(0, 0);

    expect(cell.char).toBe(65);
    expect(cell.fgRgb).toBeUndefined();
    expect(cell.bgRgb).toBeUndefined();
  });

  it("sets fgRgb/bgRgb from the explicit color bytes when colorFlags is set", async () => {
    state.line = buildCellBytes({
      codepoint: 66,
      fgR: 10,
      fgG: 20,
      fgB: 30,
      bgR: 40,
      bgG: 50,
      bgB: 60,
      colorFlags: 0b11,
    });
    state.lineLen = 1;

    const core = await GhosttyCore.load();
    core.init(80, 24);
    const cell = core.getScrollbackCell(0, 0);

    expect(cell.char).toBe(66);
    expect(cell.fgRgb).toBe((10 << 16) | (20 << 8) | 30);
    expect(cell.bgRgb).toBe((40 << 16) | (50 << 8) | 60);
  });
});

describe("GhosttyCore input modes", () => {
  it("exposes mouse and focus state", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);

    expect(core.mouseTracking()).toBe(1002);
    expect(core.mouseSgr()).toBe(true);
    expect(core.focusEvents()).toBe(true);
  });
});

describe("GhosttyCore mutation failures", () => {
  it("rolls back bridge buffers when initialization cannot allocate", async () => {
    const core = await GhosttyCore.load();
    state.freeBuffer.mockReset();
    state.allocBuffer
      .mockReturnValueOnce(64)
      .mockReturnValueOnce(65)
      .mockReturnValueOnce(0);

    expect(() => core.init(80, 24)).toThrow(/grapheme buffer/);
    expect(state.init).not.toHaveBeenCalled();
    expect(state.freeBuffer).toHaveBeenCalledTimes(2);
    expect(core.getCols()).toBe(0);
    expect(core.getRows()).toBe(0);
  });

  it("rolls back every bridge buffer when terminal initialization fails", async () => {
    const core = await GhosttyCore.load();
    state.freeBuffer.mockReset();
    state.init.mockReturnValueOnce(0);

    expect(() => core.init(80, 24)).toThrow(/initialize the WASM core/);
    expect(state.freeBuffer).toHaveBeenCalledTimes(4);
    expect(core.getCols()).toBe(0);
    expect(core.getRows()).toBe(0);
  });

  it("rejects transfer allocation failure instead of dropping input", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.allocBuffer.mockReturnValueOnce(0);

    expect(() => core.writeString("lost input")).toThrow(
      /transfer allocation failed/,
    );
    expect(state.write).not.toHaveBeenCalled();
  });

  it("frees the transfer buffer when Ghostty reports a semantic failure", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.freeBuffer.mockReset();
    state.write.mockReturnValueOnce(1);

    expect(() => core.writeString("input")).toThrow(/semantic failure/);
    expect(state.freeBuffer).toHaveBeenCalledOnce();
    expect(core.isPoisoned()).toBe(true);
    expect(() => core.writeString("retry")).toThrow(/core is poisoned/);
  });

  it("preserves local dimensions when Ghostty rejects a resize", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.freeBuffer.mockReset();
    state.resize.mockReturnValueOnce(3);

    expect(() => core.resize(100, 30)).toThrow(/rejected the resize/);
    expect(core.getCols()).toBe(80);
    expect(core.getRows()).toBe(24);
    expect(core.isPoisoned()).toBe(false);
    expect(state.freeBuffer).toHaveBeenCalledTimes(2);
  });

  it("does not resize Ghostty when replacement buffers cannot allocate", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.freeBuffer.mockReset();
    state.allocBuffer.mockReturnValueOnce(100).mockReturnValueOnce(0);

    expect(() => core.resize(100, 30)).toThrow(/scrollback buffer/);
    expect(state.resize).not.toHaveBeenCalled();
    expect(state.freeBuffer).toHaveBeenCalledOnce();
    expect(core.getCols()).toBe(80);
    expect(core.getRows()).toBe(24);
  });

  it("poisons the core without exporting a partial RenderState", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.update.mockReturnValueOnce(1);

    expect(() => core.getCell(0, 0)).toThrow(/fatal render-state failure/);
    expect(core.isPoisoned()).toBe(true);
    expect(state.getViewport).not.toHaveBeenCalled();
  });
});

describe("GhosttyCore lifecycle", () => {
  beforeEach(() => {
    state.deinit.mockReset();
    state.freeBuffer.mockReset();
  });

  it("releases its terminal and persistent buffers exactly once", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);

    core.dispose();
    core.dispose();

    expect(state.deinit).toHaveBeenCalledOnce();
    expect(state.deinit).toHaveBeenCalledWith(1);
    expect(state.freeBuffer).toHaveBeenCalledTimes(4);
    expect(state.freeBuffer.mock.calls.map(([, size]) => size)).toEqual([
      80 * 24 * CELL_BYTES,
      80 * CELL_BYTES,
      256,
      1024,
    ]);
  });

  it("never passes a null state pointer before init or after dispose", async () => {
    const core = await GhosttyCore.load();

    expect(() => core.writeString("input")).toThrow(/not initialized/);
    expect(() => core.drainEffects()).toThrow(/not initialized/);
    expect(state.write).not.toHaveBeenCalled();

    core.init(80, 24);
    core.dispose();

    expect(() => core.cursorKeysApp()).toThrow(/has been disposed/);
    expect(() => core.getEffectStats()).toThrow(/has been disposed/);
  });

  it("continues releasing resources when WASM cleanup traps", async () => {
    const core = await GhosttyCore.load();
    core.init(80, 24);
    state.freeBuffer.mockImplementationOnce(() => {
      throw new Error("free trapped");
    });
    state.deinit.mockImplementationOnce(() => {
      throw new Error("deinit trapped");
    });

    expect(() => core.dispose()).not.toThrow();
    core.dispose();

    expect(state.freeBuffer).toHaveBeenCalledTimes(4);
    expect(state.deinit).toHaveBeenCalledOnce();
    expect(core.getCols()).toBe(0);
    expect(core.getRows()).toBe(0);
  });
});
