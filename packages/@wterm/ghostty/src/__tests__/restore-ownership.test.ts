import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeBuffers: new Set<number>(),
  allocCall: 0,
  failAllocCall: 0,
  freeThrows: false,
  memory: new WebAssembly.Memory({ initial: 4 }),
  nextBufferPtr: 1024,
  phase: 1,
  phaseThrows: false,
  status: 0,
  restoreBeginThrows: false,
  statusThrows: false,
  historyThrows: false,
  historyPhaseAfter: 3,
  progressRowsThrows: false,
  writeThrows: false,
  writeStatus: 0,
  resizeThrows: false,
  resizeStatus: 0,
  takeThrows: false,
  restoreDeinitThrows: false,
  deinitState: vi.fn(),
  freeBuffer: vi.fn(),
  restoreBegin: vi.fn(),
  restoreDeinit: vi.fn(),
  restoreNextHistory: vi.fn(),
  restoreWrite: vi.fn(),
  restoreResize: vi.fn(),
  restoreTake: vi.fn(),
}));

vi.mock("../wasm-bindings.js", async () => {
  const actual = await vi.importActual<typeof import("../wasm-bindings.js")>(
    "../wasm-bindings.js",
  );
  const exports = {
    memory: state.memory,
    alloc_buffer(len: number) {
      state.allocCall += 1;
      if (state.allocCall === state.failAllocCall) return 0;
      const ptr = state.nextBufferPtr;
      state.nextBufferPtr += Math.max(1, len) + 16;
      state.activeBuffers.add(ptr);
      return ptr;
    },
    free_buffer(ptr: number) {
      state.freeBuffer(ptr);
      if (state.freeThrows) throw new Error("free_buffer trapped");
      state.activeBuffers.delete(ptr);
    },
    restore_begin() {
      state.restoreBegin();
      if (state.restoreBeginThrows) throw new Error("restore_begin trapped");
      return 500;
    },
    restore_phase() {
      if (state.phaseThrows) throw new Error("phase trapped");
      return state.phase;
    },
    restore_status() {
      if (state.statusThrows) throw new Error("status trapped");
      return state.status;
    },
    restore_next_history() {
      state.restoreNextHistory();
      if (state.historyThrows) throw new Error("history trapped");
      state.phase = state.historyPhaseAfter;
      return 0;
    },
    restore_progress_screen: () => 0,
    restore_progress_rows() {
      if (state.progressRowsThrows) throw new Error("progress trapped");
      return 1;
    },
    restore_progress_remaining: () => 0,
    restore_abandon_history() {
      state.phase = 4;
      return 0;
    },
    restore_write() {
      state.restoreWrite();
      if (state.writeThrows) throw new Error("write trapped");
      if (state.writeStatus === 6) {
        state.phase = 5;
        state.status = 6;
      }
      return state.writeStatus;
    },
    restore_resize() {
      state.restoreResize();
      if (state.resizeThrows) throw new Error("resize trapped");
      return state.resizeStatus;
    },
    restore_take_state() {
      state.restoreTake();
      if (state.takeThrows) throw new Error("take trapped");
      state.phase = 6;
      return 700;
    },
    restore_deinit() {
      state.restoreDeinit();
      if (state.restoreDeinitThrows) throw new Error("restore_deinit trapped");
    },
    terminal_cols: () => 10,
    terminal_rows: () => 2,
    deinit(ptr: number) {
      state.deinitState(ptr);
    },
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

const { GhosttyRuntime } = await import("../ghostty-runtime.js");

beforeEach(() => {
  state.activeBuffers.clear();
  state.allocCall = 0;
  state.failAllocCall = 0;
  state.freeThrows = false;
  state.nextBufferPtr = 1024;
  state.phase = 1;
  state.phaseThrows = false;
  state.status = 0;
  state.restoreBeginThrows = false;
  state.statusThrows = false;
  state.historyThrows = false;
  state.historyPhaseAfter = 3;
  state.progressRowsThrows = false;
  state.writeThrows = false;
  state.writeStatus = 0;
  state.resizeThrows = false;
  state.resizeStatus = 0;
  state.takeThrows = false;
  state.restoreDeinitThrows = false;
  state.deinitState.mockReset();
  state.freeBuffer.mockReset();
  state.restoreBegin.mockReset();
  state.restoreDeinit.mockReset();
  state.restoreNextHistory.mockReset();
  state.restoreWrite.mockReset();
  state.restoreResize.mockReset();
  state.restoreTake.mockReset();
});

const options = {
  effects: "discard",
  maxContinuationBytes: 64 * 1024,
} as const;

function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

describe("Ghostty passive restore failure ownership", () => {
  it("fails before native restore when the input transfer cannot allocate", async () => {
    const runtime = await GhosttyRuntime.load();
    state.failAllocCall = 1;

    expect(() =>
      runtime.beginPassiveRestore(Uint8Array.of(1), options),
    ).toThrow(/ran out of memory/);
    expect(state.activeBuffers.size).toBe(0);
    expect(state.restoreBegin).not.toHaveBeenCalled();
    expect(state.restoreDeinit).not.toHaveBeenCalled();
  });

  it("frees the input transfer when restore_begin traps", async () => {
    const runtime = await GhosttyRuntime.load();
    state.restoreBeginThrows = true;

    expect(() =>
      runtime.beginPassiveRestore(Uint8Array.of(1), options),
    ).toThrow(/restore_begin trapped/);
    expect(state.activeBuffers.size).toBe(0);
    expect(state.restoreDeinit).not.toHaveBeenCalled();
  });

  it("destroys a native handle when snapshot transfer cleanup traps", async () => {
    const runtime = await GhosttyRuntime.load();
    state.freeThrows = true;

    expect(
      captureError(() =>
        runtime.beginPassiveRestore(Uint8Array.of(1), options),
      ),
    ).toMatchObject({ fatal: true, status: "unknown" });
    expect(state.freeBuffer).toHaveBeenCalledOnce();
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it("disposes the native handle when its initial phase query traps", async () => {
    const runtime = await GhosttyRuntime.load();
    state.phaseThrows = true;

    expect(
      captureError(() =>
        runtime.beginPassiveRestore(Uint8Array.of(1), options),
      ),
    ).toMatchObject({ fatal: true, status: "unknown" });
    expect(state.activeBuffers.size).toBe(0);
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it("disposes the native handle when failed READY status traps", async () => {
    const runtime = await GhosttyRuntime.load();
    state.phase = 5;
    state.status = 1;
    state.statusThrows = true;

    expect(
      captureError(() =>
        runtime.beginPassiveRestore(Uint8Array.of(1), options),
      ),
    ).toMatchObject({ fatal: true, status: "unknown" });
    expect(state.activeBuffers.size).toBe(0);
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it.each(["phase", "status"] as const)(
    "fails closed and caches a fatal error when a live %s query traps",
    async (query) => {
      const runtime = await GhosttyRuntime.load();
      const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
      state.restoreDeinitThrows = true;
      if (query === "phase") state.phaseThrows = true;
      else state.statusThrows = true;

      const first = captureError(() => {
        void restore[query];
      });
      expect(first).toMatchObject({ fatal: true, status: "unknown" });
      expect(captureError(() => restore.decodeNextHistory())).toBe(first);
      expect(captureError(() => restore.takeCore())).toBe(first);
      expect(state.restoreDeinit).toHaveBeenCalledOnce();

      restore.dispose();
      expect(state.restoreDeinit).toHaveBeenCalledOnce();
    },
  );

  it.each(["history", "progress"] as const)(
    "fails closed when a %s decode boundary traps",
    async (boundary) => {
      const runtime = await GhosttyRuntime.load();
      const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
      if (boundary === "history") state.historyThrows = true;
      else {
        state.historyPhaseAfter = 2;
        state.progressRowsThrows = true;
      }

      const first = captureError(() => restore.decodeNextHistory());
      expect(first).toMatchObject({ fatal: true, status: "unknown" });
      expect(captureError(() => restore.decodeNextHistory())).toBe(first);
      expect(state.restoreNextHistory).toHaveBeenCalledOnce();
      expect(state.restoreDeinit).toHaveBeenCalledOnce();
    },
  );

  it.each(["write", "resize"] as const)(
    "fails closed when a post-snapshot %s traps",
    async (mutation) => {
      const runtime = await GhosttyRuntime.load();
      const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
      await restore.advanceToFinish({ yieldBetweenPages: false });
      if (mutation === "write") state.writeThrows = true;
      else state.resizeThrows = true;

      const first = captureError(() => {
        if (mutation === "write") restore.writeRaw(Uint8Array.of(1));
        else restore.resize(10, 2);
      });
      expect(first).toMatchObject({ fatal: true, status: "unknown" });
      expect(captureError(() => restore.takeCore())).toBe(first);
      expect(state.restoreDeinit).toHaveBeenCalledOnce();
      expect(state.activeBuffers.size).toBe(0);
    },
  );

  it("fails closed when restored State transfer traps", async () => {
    const runtime = await GhosttyRuntime.load();
    const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
    await restore.advanceToFinish({ yieldBetweenPages: false });
    state.takeThrows = true;

    const first = captureError(() => restore.takeCore());
    expect(first).toMatchObject({ fatal: true, status: "unknown" });
    expect(captureError(() => restore.takeCore())).toBe(first);
    expect(state.restoreTake).toHaveBeenCalledOnce();
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it("fails closed if transfer cleanup traps after a committed mutation", async () => {
    const runtime = await GhosttyRuntime.load();
    const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
    await restore.advanceToFinish({ yieldBetweenPages: false });
    state.freeThrows = true;

    const first = captureError(() => restore.writeRaw(Uint8Array.of(1)));
    expect(first).toMatchObject({ fatal: true, status: "unknown" });
    expect(captureError(() => restore.writeRaw(Uint8Array.of(2)))).toBe(first);
    expect(state.restoreWrite).toHaveBeenCalledOnce();
    expect(state.freeBuffer).toHaveBeenCalledTimes(2);
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it("keeps pre-mutation allocation failure and typed resize failure retryable", async () => {
    const runtime = await GhosttyRuntime.load();
    const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
    await restore.advanceToFinish({ yieldBetweenPages: false });
    state.failAllocCall = state.allocCall + 1;

    expect(() => restore.writeRaw(Uint8Array.of(1))).toThrow(
      /ran out of memory/,
    );
    expect(restore.phase).toBe("finish");
    state.failAllocCall = 0;
    restore.writeRaw(Uint8Array.of(2));

    state.resizeStatus = 7;
    expect(() => restore.resize(11, 3)).toThrow(/post-snapshot resize/);
    expect(restore.phase).toBe("finish");
    state.resizeStatus = 0;
    restore.resize(12, 4);
    expect(state.restoreResize).toHaveBeenCalledTimes(2);
    expect(state.restoreDeinit).not.toHaveBeenCalled();

    restore.dispose();
  });

  it("keeps a typed write mutation failure in native failed state", async () => {
    const runtime = await GhosttyRuntime.load();
    const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
    await restore.advanceToFinish({ yieldBetweenPages: false });
    state.writeStatus = 6;

    expect(
      captureError(() => restore.writeRaw(Uint8Array.of(1))),
    ).toMatchObject({
      fatal: false,
      status: "mutationFailure",
    });
    expect(restore.phase).toBe("failed");
    expect(() => restore.takeCore()).toThrow(/failed phase/);
    expect(state.restoreDeinit).not.toHaveBeenCalled();

    restore.dispose();
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });

  it("destroys a transferred State when core bridge allocation fails", async () => {
    const runtime = await GhosttyRuntime.load();
    const restore = runtime.beginPassiveRestore(Uint8Array.of(1), options);
    await restore.advanceToFinish({ yieldBetweenPages: false });
    state.failAllocCall = state.allocCall + 3;

    expect(() => restore.takeCore()).toThrow(/grapheme buffer/);
    expect(restore.phase).toBe("taken");
    expect(state.deinitState).toHaveBeenCalledOnce();
    expect(state.deinitState).toHaveBeenCalledWith(700);
    expect(state.activeBuffers.size).toBe(0);

    restore.dispose();
    restore.dispose();
    expect(state.deinitState).toHaveBeenCalledOnce();
    expect(state.restoreDeinit).toHaveBeenCalledOnce();
  });
});
