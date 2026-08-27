import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GhosttyCore,
  GhosttyModifier,
  ghosttyKeyEventFromDom,
} from "../ghostty-core.js";
import {
  GHOSTTY_BUILD_ID,
  GHOSTTY_ENGINE_ID,
  GHOSTTY_ENGINE_MANIFEST,
} from "../engine.js";
import { GhosttyMutationError, GhosttyRuntime } from "../wasm-bindings.js";

const wasmBytes = readFileSync(
  fileURLToPath(new URL("../../wasm/ghostty-vt.wasm", import.meta.url)),
);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function snapshotContinuation(snapshot: Uint8Array): Uint8Array {
  const view = new DataView(
    snapshot.buffer,
    snapshot.byteOffset,
    snapshot.byteLength,
  );
  expect(decoder.decode(snapshot.subarray(0, 8))).toBe("GHOSTSNP");
  expect(view.getUint16(8, true)).toBe(1);

  for (let offset = 10; offset + 10 <= snapshot.byteLength; ) {
    const tag = view.getUint16(offset, true);
    const payloadLength = view.getUint32(offset + 2, true);
    const payloadStart = offset + 10;
    const payloadEnd = payloadStart + payloadLength;
    expect(payloadEnd).toBeLessThanOrEqual(snapshot.byteLength);
    if (tag === 7) return snapshot.slice(payloadStart, payloadEnd);
    offset = payloadEnd;
  }
  throw new Error("snapshot does not contain a CONTINUATION record");
}

async function runtimeFromBytes(): Promise<GhosttyRuntime> {
  return GhosttyRuntime.load(wasmBytes);
}

describe("GhosttyRuntime", () => {
  it("loads BufferSource and exposes the exact engine identity", async () => {
    const runtime = await runtimeFromBytes();

    expect(runtime.engineId).toBe(GHOSTTY_ENGINE_ID);
    expect(runtime.artifactVerified).toBe(true);
    expect(runtime.manifest).toEqual(GHOSTTY_ENGINE_MANIFEST);
    expect(runtime.manifest.provenance.ghosttyCommit).toHaveLength(40);
    expect(runtime.manifest.provenance.snapshotSchemaSha256).toHaveLength(64);
    expect(runtime.manifest.provenance.committedWasmSha256).toBe(
      runtime.manifest.wasmSha256,
    );
    expect(runtime.manifest.wasmSha256).toHaveLength(64);
  });

  it("loads a precompiled WebAssembly.Module", async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const runtime = await GhosttyRuntime.load(module);

    expect(runtime.wasm.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(runtime.artifactVerified).toBe(false);
  });

  it("loads the package file URL directly under Node.js", async () => {
    const runtime = await GhosttyRuntime.load();

    expect(runtime.engineId).toBe(GHOSTTY_ENGINE_ID);
  });

  it("fails closed when the embedded build identity differs", async () => {
    const stale = Uint8Array.from(wasmBytes);
    const id = new TextEncoder().encode(GHOSTTY_BUILD_ID);
    const offset = stale.findIndex((_, index) =>
      id.every((byte, idIndex) => stale[index + idIndex] === byte),
    );
    expect(offset).toBeGreaterThan(0);
    stale[offset] = "x".charCodeAt(0);

    const staleModule = await WebAssembly.compile(stale);
    await expect(GhosttyRuntime.load(staleModule)).rejects.toThrow(
      /build mismatch/,
    );
  });

  it("fails closed when committed WASM bytes differ from the manifest", async () => {
    const stale = Uint8Array.from(wasmBytes);
    const id = new TextEncoder().encode(GHOSTTY_BUILD_ID);
    const offset = stale.findIndex((_, index) =>
      id.every((byte, idIndex) => stale[index + idIndex] === byte),
    );
    expect(offset).toBeGreaterThan(0);
    stale[offset] = "x".charCodeAt(0);

    await expect(GhosttyRuntime.load(stale)).rejects.toThrow(
      /WASM content mismatch/,
    );
  });

  it("hosts independent authority and replica cores in one WASM instance", async () => {
    const runtime = await runtimeFromBytes();
    const authority = GhosttyCore.fromRuntime(runtime, {
      effects: "authority",
    });
    const replica = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
    authority.init(20, 4);
    replica.init(20, 4);

    authority.writeString("A\x1b[6n");
    replica.writeString("B\x1b[6n");

    expect(
      authority.drainEffects().map((value) => decoder.decode(value)),
    ).toEqual(["\x1b[1;2R"]);
    expect(replica.drainEffects()).toEqual([]);
    expect(authority.getCell(0, 0).char).toBe("A".codePointAt(0));
    expect(replica.getCell(0, 0).char).toBe("B".codePointAt(0));

    authority.dispose();
    replica.dispose();
  });
});

describe("GhosttyCore authority primitives", () => {
  it("tracks unfinished parser state in the encoded snapshot", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);
    core.writeRaw(new Uint8Array([0x1b, 0x5b, 0x33, 0x31]));

    expect(core.getContinuation()).toEqual(
      new Uint8Array([0x1b, 0x5b, 0x33, 0x31]),
    );
    const snapshot = core.encodeSnapshot();
    expect(snapshot.byteLength).toBeGreaterThan(1000);
    expect(snapshotContinuation(snapshot)).toEqual(
      new Uint8Array([0x1b, 0x5b, 0x33, 0x31]),
    );

    core.writeString("mX");
    expect(core.getContinuation()).toEqual(new Uint8Array());
    expect(core.getCell(0, 0).char).toBe("X".codePointAt(0));
    core.dispose();
  });

  it("encodes key, paste, and focus from authoritative modes", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);

    expect(decoder.decode(core.encodeKey({ key: "ArrowUp" }))).toBe("\x1b[A");
    core.writeString("\x1b[?1h");
    expect(decoder.decode(core.encodeKey({ key: "ArrowUp" }))).toBe("\x1bOA");

    expect(decoder.decode(core.encodePaste("a\nb"))).toBe("a\rb");
    core.writeString("\x1b[?2004h");
    expect(decoder.decode(core.encodePaste("a\nb"))).toBe(
      "\x1b[200~a\nb\x1b[201~",
    );

    expect(core.encodeFocus(true)).toEqual(new Uint8Array());
    core.writeString("\x1b[?1004h");
    expect(decoder.decode(core.encodeFocus(true))).toBe("\x1b[I");
    expect(decoder.decode(core.encodeFocus(false))).toBe("\x1b[O");

    expect(
      decoder.decode(
        core.encodeKey({
          key: "KeyC",
          text: "C",
          modifiers: GhosttyModifier.Control | GhosttyModifier.Shift,
        }),
      ),
    ).toBe("\x1b[99;6u");
    core.dispose();
  });

  it("rejects non-scalar key metadata through the real WASM ABI", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);

    expect(() =>
      core.encodeKey({ key: "KeyA", unshiftedCodepoint: 0x11_0000 }),
    ).toThrow(/key encoding failed/);
    expect(() =>
      core.encodeKey({ key: "KeyA", unshiftedCodepoint: 0xd800 }),
    ).toThrow(/key encoding failed/);
    expect(core.isPoisoned()).toBe(false);
    core.dispose();
  });

  it("removes browser-synthesized Ctrl+Alt from AltGraph text", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);
    const event = ghosttyKeyEventFromDom({
      type: "keydown",
      code: "KeyQ",
      key: "@",
      shiftKey: false,
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      repeat: false,
      getModifierState: (key) => key === "AltGraph",
    });

    expect(event).toMatchObject({
      code: "KeyQ",
      key: "@",
      text: "@",
      modifiers: 0,
      consumedModifiers: 0,
      altGraph: true,
      action: "press",
      composing: false,
    });
    expect(decoder.decode(core.encodeKey(event))).toBe("@");
    core.dispose();
  });

  it("falls back to the logical key when a DOM event has no physical code", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);
    const event = ghosttyKeyEventFromDom({
      type: "keydown",
      code: "",
      key: "ArrowUp",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    });

    expect(decoder.decode(core.encodeKey(event))).toBe("\x1b[A");
    core.dispose();
  });

  it("bounds the synchronous effect queue and reports drops", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);

    let failure: unknown;
    try {
      core.writeString("\x1b[6n".repeat(300));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GhosttyMutationError);
    expect(failure).toMatchObject({ mutationCommitted: true, fatal: true });
    expect(core.isPoisoned()).toBe(true);

    expect(core.drainEffects()).toHaveLength(256);
    expect(core.getEffectStats()).toEqual({
      droppedFrames: 44,
      droppedBytes: 264,
    });
    expect(() => core.writeString("retry")).toThrow(/core is poisoned/);
    core.dispose();
  });

  it("rejects an invalid resize without changing local dimensions", async () => {
    const runtime = await runtimeFromBytes();
    const core = GhosttyCore.fromRuntime(runtime);
    core.init(20, 4);

    expect(() => core.resize(0, 5)).toThrow(/positive 16-bit integers/);
    expect(core.getCols()).toBe(20);
    expect(core.getRows()).toBe(4);
    expect(core.isPoisoned()).toBe(false);
    core.dispose();
  });
});

describe.each([
  { name: "partial UTF-8", input: encoder.encode("A€B") },
  { name: "device attributes", input: encoder.encode("\x1b[c") },
  { name: "OSC query", input: encoder.encode("\x1b]10;?\x1b\\") },
  { name: "OSC mutation", input: encoder.encode("\x1b]10;#123456\x1b\\") },
  {
    name: "DCS XTGETTCAP",
    input: encoder.encode("\x1bP+q544E\x1b\\"),
  },
  {
    name: "committed action plus partial CSI",
    input: encoder.encode("\x1b[c\x1b[6n"),
  },
])("Ghostty continuation: $name", ({ input }) => {
  it("survives every byte cut without duplicating state or effects", async () => {
    const runtime = await runtimeFromBytes();
    const baseline = GhosttyCore.fromRuntime(runtime);
    baseline.init(20, 4);
    baseline.writeRaw(input);
    baseline.drainEffects();
    const baselineSnapshot = baseline.encodeSnapshot();

    for (let cut = 0; cut <= input.byteLength; cut += 1) {
      const prefix = input.subarray(0, cut);
      const tail = input.subarray(cut);
      const authority = GhosttyCore.fromRuntime(runtime);
      const replica = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
      const replay = GhosttyCore.fromRuntime(runtime);
      authority.init(20, 4);
      replica.init(20, 4);
      replay.init(20, 4);

      authority.writeRaw(prefix);
      const continuation = authority.getContinuation();
      expect(snapshotContinuation(authority.encodeSnapshot())).toEqual(
        continuation,
      );
      expect(authority.getContinuation()).toEqual(continuation);
      authority.drainEffects();
      authority.writeRaw(tail);
      const tailEffects = authority.drainEffects();
      expect(authority.encodeSnapshot()).toEqual(baselineSnapshot);

      replica.writeRaw(prefix);
      expect(replica.getContinuation()).toEqual(continuation);
      expect(snapshotContinuation(replica.encodeSnapshot())).toEqual(
        continuation,
      );
      expect(replica.drainEffects()).toEqual([]);
      replica.writeRaw(tail);
      expect(replica.drainEffects()).toEqual([]);
      expect(replica.encodeSnapshot()).toEqual(baselineSnapshot);

      replay.writeRaw(continuation);
      expect(replay.drainEffects()).toEqual([]);
      replay.writeRaw(tail);
      expect(replay.drainEffects()).toEqual(tailEffects);

      authority.dispose();
      replica.dispose();
      replay.dispose();
    }
    baseline.dispose();
  });
});
