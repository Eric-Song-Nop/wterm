import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { GhosttyCore } from "../ghostty-core.js";
import { GhosttyRuntime } from "../ghostty-runtime.js";

const wasmBytes = readFileSync(
  fileURLToPath(new URL("../../wasm/ghostty-vt.wasm", import.meta.url)),
);
const encoder = new TextEncoder();

const continuationFixtures = [
  {
    name: "UTF-8",
    prefix: Uint8Array.of(0xe2, 0x82),
    tail: Uint8Array.of(0xac),
  },
  {
    name: "CSI",
    prefix: encoder.encode("\x1b[31"),
    tail: encoder.encode("mC"),
  },
  {
    name: "OSC",
    prefix: encoder.encode("\x1b]8;id=link;https://example.com"),
    tail: encoder.encode("\x1b\\O\x1b]8;;\x1b\\"),
  },
  {
    name: "DCS",
    prefix: encoder.encode("\x1bP+q54"),
    tail: encoder.encode("4e\x1b\\D"),
  },
] as const;

function writeLargeHistory(core: GhosttyCore, marker: string): void {
  core.writeString(
    Array.from(
      { length: 5_000 },
      (_, row) =>
        `${marker}${String(row).padStart(5, "0")}${marker.repeat(72)}\r\n`,
    ).join(""),
  );
}

function corruptFirstHistoryPage(snapshot: Uint8Array): Uint8Array {
  const corrupted = snapshot.slice();
  const view = new DataView(
    corrupted.buffer,
    corrupted.byteOffset,
    corrupted.byteLength,
  );
  let ready = false;
  for (let offset = 10; offset + 10 <= corrupted.byteLength; ) {
    const tag = view.getUint16(offset, true);
    const payloadLength = view.getUint32(offset + 2, true);
    if (ready && tag === 3) {
      corrupted[offset + 6] ^= 0xff;
      return corrupted;
    }
    if (tag === 5) ready = true;
    offset += 10 + payloadLength;
  }
  throw new Error("fixture has no history PAGE record");
}

describe("Ghostty passive snapshot restore", () => {
  it("restores READY synchronously and transfers a FINISH terminal once", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "authority" });
    source.init(12, 3);
    source.writeString("restored");

    const restore = runtime.beginPassiveRestore(source.encodeSnapshot(), {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    expect(restore.phase).toBe("ready");
    expect(restore.status).toBe("ok");
    expect(() => restore.writeRaw(encoder.encode("early"))).toThrow(
      /ready phase/,
    );
    expect(() => restore.takeCore()).toThrow(/ready phase/);

    await restore.advanceToFinish();
    expect(restore.phase).toBe("finish");
    restore.resize(14, 4);
    const restored = restore.takeCore();
    expect(restore.phase).toBe("taken");
    expect(restored.getCell(0, 0).char).toBe("r".codePointAt(0));
    expect(restored.getCols()).toBe(14);
    expect(restored.getRows()).toBe(4);
    expect(() => restore.takeCore()).toThrow(/already transferred/);
    expect(restored.drainEffects()).toEqual([]);

    restore.dispose();
    expect(restore.status).toBe("disposed");
    restored.dispose();
    source.dispose();
  });

  it("streams primary and alternate history one page at a time without losing rich cells", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, {
      effects: "discard",
      scrollbackLimit: 4 * 1024 * 1024,
    });
    source.init(80, 2);
    writeLargeHistory(source, "p");
    source.writeString(
      "\x1b]8;id=primary;https://example.com\x1b\\e\u0301\x1b]8;;\x1b\\",
    );
    source.writeString("\x1b[?1049h");
    writeLargeHistory(source, "a");
    source.writeString("alt\u0301");
    const snapshot = source.encodeSnapshot();

    const restore = runtime.beginPassiveRestore(snapshot, {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    const screens = new Set<string>();
    let pages = 0;
    while (restore.phase !== "finish") {
      const progress = restore.decodeNextHistory();
      if (progress) {
        pages += 1;
        screens.add(progress.screen);
        expect(progress.rows).toBeGreaterThan(0);
      }
    }

    expect(pages).toBeGreaterThan(2);
    // Ghostty's alternate screen is encoded in READY but intentionally has no
    // scrollback sequence; primary history is streamed after it.
    expect(screens).toEqual(new Set(["primary"]));
    const restored = restore.takeCore();
    expect(restored.encodeSnapshot()).toEqual(snapshot);
    expect(restored.drainEffects()).toEqual([]);

    restored.dispose();
    restore.dispose();
    source.dispose();
  });

  it("abandons slow history before applying the transport tail", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, {
      effects: "discard",
      scrollbackLimit: 1024 * 1024,
    });
    source.init(16, 3);
    source.writeString("before\r\ncheckpoint");
    const restore = runtime.beginPassiveRestore(source.encodeSnapshot(), {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });

    restore.abandonHistory();
    expect(restore.phase).toBe("abandoned");
    expect(() => restore.decodeNextHistory()).toThrow(/abandoned phase/);
    const tail = encoder.encode("\x1b[6n-tail");
    source.writeRaw(tail);
    restore.writeRaw(tail);

    const restored = restore.takeCore();
    expect(restored.encodeSnapshot()).toEqual(source.encodeSnapshot());
    expect(restored.drainEffects()).toEqual([]);

    restored.dispose();
    restore.dispose();
    restore.dispose();
    source.dispose();
  });

  it.each(continuationFixtures)(
    "replays a half $name continuation exactly once before its tail",
    async ({ prefix, tail }) => {
      const runtime = await GhosttyRuntime.load(wasmBytes);
      const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
      source.init(20, 4);
      source.writeString("base:");
      source.writeRaw(prefix);

      const restore = runtime.beginPassiveRestore(source.encodeSnapshot(), {
        effects: "discard",
        maxContinuationBytes: 64 * 1024,
      });
      await restore.advanceToFinish();
      source.writeRaw(tail);
      restore.writeRaw(tail);

      const restored = restore.takeCore();
      expect(restored.encodeSnapshot()).toEqual(source.encodeSnapshot());
      expect(restored.drainEffects()).toEqual([]);

      restored.dispose();
      restore.dispose();
      source.dispose();
    },
  );

  it("rejects bad magic, version, CRC, truncation, and continuation bounds", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    source.init(20, 4);
    source.writeString("checkpoint\x1b[31");
    const snapshot = source.encodeSnapshot();

    const badMagic = snapshot.slice();
    badMagic[0] ^= 0xff;
    const badVersion = snapshot.slice();
    badVersion[8] = 2;
    badVersion[9] = 0;
    const badCrc = snapshot.slice();
    badCrc[20] ^= 0xff;
    const truncated = snapshot.slice(0, -1);

    for (const invalid of [badMagic, badVersion, badCrc]) {
      expect(() =>
        runtime.beginPassiveRestore(invalid, {
          effects: "discard",
          maxContinuationBytes: 64 * 1024,
        }),
      ).toThrow(/malformed, truncated, or failed integrity checks/);
    }
    const truncatedRestore = runtime.beginPassiveRestore(truncated, {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    await expect(truncatedRestore.advanceToFinish()).rejects.toThrow(
      /malformed, truncated, or failed integrity checks/,
    );
    expect(truncatedRestore.phase).toBe("failed");
    truncatedRestore.dispose();
    expect(() =>
      runtime.beginPassiveRestore(snapshot, {
        effects: "discard",
        maxContinuationBytes: 3,
      }),
    ).toThrow(/exceeds maxContinuationBytes/);

    source.dispose();
  });

  it("accepts a zero continuation cap only for a ground snapshot", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    source.init(10, 2);
    source.writeString("ground");
    const snapshot = source.encodeSnapshot();

    const restore = runtime.beginPassiveRestore(snapshot, {
      effects: "discard",
      maxContinuationBytes: 0,
    });
    await restore.advanceToFinish({ yieldBetweenPages: false });
    const restored = restore.takeCore();
    expect(restored.encodeSnapshot()).toEqual(snapshot);

    restored.dispose();
    restore.dispose();
    source.dispose();
  });

  it("fails closed when a history PAGE CRC is corrupt", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, {
      effects: "discard",
      scrollbackLimit: 4 * 1024 * 1024,
    });
    source.init(80, 2);
    writeLargeHistory(source, "h");
    const corrupted = corruptFirstHistoryPage(source.encodeSnapshot());

    const restore = runtime.beginPassiveRestore(corrupted, {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    expect(() => restore.decodeNextHistory()).toThrow(
      /malformed, truncated, or failed integrity checks/,
    );
    expect(restore.phase).toBe("failed");
    expect(() => restore.takeCore()).toThrow(/failed phase/);
    restore.dispose();
    restore.dispose();
    source.dispose();
  });

  it("requires EOF after FINISH but lets explicit abandonment discard the remainder", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    source.init(10, 2);
    source.writeString("bounded");
    const snapshot = source.encodeSnapshot();
    const trailingByte = new Uint8Array(snapshot.byteLength + 1);
    trailingByte.set(snapshot);
    trailingByte[trailingByte.length - 1] = 0xff;
    const concatenated = new Uint8Array(snapshot.byteLength * 2);
    concatenated.set(snapshot);
    concatenated.set(snapshot, snapshot.byteLength);

    for (const invalid of [trailingByte, concatenated]) {
      const restore = runtime.beginPassiveRestore(invalid, {
        effects: "discard",
        maxContinuationBytes: 64 * 1024,
      });
      await expect(
        restore.advanceToFinish({ yieldBetweenPages: false }),
      ).rejects.toThrow(/malformed, truncated, or failed integrity checks/);
      expect(restore.phase).toBe("failed");
      restore.dispose();
    }

    const abandoned = runtime.beginPassiveRestore(concatenated, {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    abandoned.abandonHistory();
    abandoned.writeRaw(encoder.encode("-tail"));
    const restored = abandoned.takeCore();
    expect(restored.getCell(0, 0).char).toBe("b".codePointAt(0));
    expect(restored.drainEffects()).toEqual([]);

    restored.dispose();
    abandoned.dispose();
    source.dispose();
  });

  it("turns an asynchronous history abort into explicit abandonment", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, {
      effects: "discard",
      scrollbackLimit: 4 * 1024 * 1024,
    });
    source.init(80, 2);
    writeLargeHistory(source, "z");
    const restore = runtime.beginPassiveRestore(source.encodeSnapshot(), {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    await expect(
      restore.advanceToFinish({
        signal: controller.signal,
        yieldBetweenPages: true,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(restore.phase).toBe("abandoned");
    restore.writeRaw(encoder.encode("tail"));
    const restored = restore.takeCore();
    expect(restored.drainEffects()).toEqual([]);

    restored.dispose();
    restore.dispose();
    source.dispose();
  });

  it("survives 1000 restore, abandon, take, and dispose ownership cycles", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    source.init(10, 2);
    source.writeString("stress");
    const snapshot = source.encodeSnapshot();
    const baseline = {
      buffers: runtime.wasm.exports.live_bridge_buffers(),
      handles: runtime.wasm.exports.live_restore_handles(),
      states: runtime.wasm.exports.live_terminal_states(),
    };

    try {
      for (let iteration = 0; iteration < 1_000; iteration += 1) {
        const restore = runtime.beginPassiveRestore(snapshot, {
          effects: "discard",
          maxContinuationBytes: 64 * 1024,
        });
        if (iteration % 3 === 0) {
          restore.dispose();
        } else if (iteration % 3 === 1) {
          restore.abandonHistory();
          const core = restore.takeCore();
          core.dispose();
          restore.dispose();
        } else {
          await restore.advanceToFinish({ yieldBetweenPages: false });
          const core = restore.takeCore();
          core.dispose();
          restore.dispose();
        }
        restore.dispose();
        expect(runtime.wasm.exports.live_restore_handles()).toBe(
          baseline.handles,
        );
        expect(runtime.wasm.exports.live_terminal_states()).toBe(
          baseline.states,
        );
        expect(runtime.wasm.exports.live_bridge_buffers()).toBe(
          baseline.buffers,
        );
      }
    } finally {
      log.mockRestore();
    }

    source.dispose();
    expect(runtime.wasm.exports.live_restore_handles()).toBe(0);
    expect(runtime.wasm.exports.live_terminal_states()).toBe(0);
    expect(runtime.wasm.exports.live_bridge_buffers()).toBe(0);
  });

  it("rebuilds adopted core views after shared WASM memory grows", async () => {
    const runtime = await GhosttyRuntime.load(wasmBytes);
    const source = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    source.init(10, 2);
    source.writeString("view");
    const restore = runtime.beginPassiveRestore(source.encodeSnapshot(), {
      effects: "discard",
      maxContinuationBytes: 64 * 1024,
    });
    await restore.advanceToFinish({ yieldBetweenPages: false });
    const restored = restore.takeCore();
    expect(restored.getCell(0, 0).char).toBe("v".codePointAt(0));

    const previousMemory = runtime.wasm.exports.memory.buffer;
    const allocationSize = previousMemory.byteLength;
    const growthPtr = runtime.wasm.exports.alloc_buffer(allocationSize);
    expect(growthPtr).not.toBe(0);
    expect(runtime.wasm.exports.memory.buffer).not.toBe(previousMemory);
    expect(restored.getCell(0, 0).char).toBe("v".codePointAt(0));
    runtime.wasm.exports.free_buffer(growthPtr, allocationSize);

    restored.dispose();
    restore.dispose();
    source.dispose();
  });
});
