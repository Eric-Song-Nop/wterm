# @wterm/ghostty

Full-featured terminal emulation core for [wterm](https://github.com/vercel-labs/wterm), powered by [libghostty](https://ghostty.org) built from source.

Drop-in replacement for wterm's built-in Zig core. Implements the same `TerminalCore` interface with comprehensive VT emulation: proper Unicode grapheme handling, all SGR attributes, terminal modes, and more.

The core exposes X10/normal/button/any mouse tracking (modes 9, 1000, 1002, and 1003), SGR and SGR-pixel coordinates (1006 and 1016), focus reporting (1004), synchronized-output state (2026), and terminal responses including foreground/background color queries (OSC 10 and OSC 11) to `@wterm/dom`.
Combining marks and ZWJ emoji are exposed through `CellData.chars` as complete strings, including after their rows move into scrollback.
Native OSC 8 hyperlinks are resolved from Ghostty's page-owned metadata and exposed through `CellData.linkUri`, `CellData.linkId`, and `CellData.linkKey` in both the viewport and scrollback.

The pinned Ghostty revision does not expose a cumulative discarded-row counter. The optional `TerminalCore.getScrollbackDiscardedCount()` signal is therefore omitted instead of returning a misleading retained-row value. A future Ghostty fork accessor must be included in the exact engine identity before restoring that API.

## Install

```bash
npm install @wterm/ghostty
```

## Usage

### Vanilla JS

```ts
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import "@wterm/dom/css";

const core = await GhosttyCore.load();
const term = new WTerm(document.getElementById("terminal"), { core });
await term.init();
```

`WTerm` owns the core above and calls its idempotent `dispose()` method on replacement or destruction. Code that uses `GhosttyCore` without `WTerm` must call `dispose()` itself to release the libghostty terminal and WASM bridge buffers.

### React

```tsx
import { Terminal } from "@wterm/react";
import { GhosttyCore } from "@wterm/ghostty";
import "@wterm/dom/css";

const core = await GhosttyCore.load();

function App() {
  return <Terminal core={core} />;
}
```

### Vue

```vue
<script setup lang="ts">
import { Terminal } from "@wterm/vue";
import { GhosttyCore } from "@wterm/ghostty";

const core = await GhosttyCore.load();
</script>

<template>
  <Terminal :core="core" />
</template>
```

## Options

`GhosttyCore.load()` accepts an options object:

| Option            | Type                                                  | Description                                                                                                             |
| ----------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `wasmSource`      | `string \| URL \| BufferSource \| WebAssembly.Module` | WASM input for browsers, Node.js, and precompiled-module caches                                                         |
| `wasmPath`        | `string`                                              | Deprecated URL/path alias for `wasmSource`                                                                              |
| `scrollbackLimit` | `number`                                              | Scrollback memory budget in bytes (default: 10000)                                                                      |
| `foregroundColor` | `string`                                              | Foreground reported by OSC 10 in `#RRGGBB` format (default: `#d4d4d4`)                                                  |
| `backgroundColor` | `string`                                              | Background reported by OSC 11 in `#RRGGBB` format (default: `#1e1e1e`)                                                  |
| `effects`         | `"authority" \| "discard"`                            | Enable bounded `WRITE_PTY` effects for a Host authority or suppress them for a browser replica (default: `"authority"`) |

When using a custom CSS theme, pass matching foreground and background colors so terminal applications receive the colors they are actually rendered with:

```ts
const core = await GhosttyCore.load({
  foregroundColor: "#ededed",
  backgroundColor: "#0a0a0a",
});
```

## Bundlers

The WASM binary is fetched at runtime, not inlined, so the default has to resolve to a URL your app actually serves. `GhosttyCore.load()` resolves it with `new URL("../wasm/ghostty-vt.wasm", import.meta.url)`. Bundlers that implement that asset pattern emit the binary and rewrite the URL; ones that do not leave `import.meta.url` pointing at the machine that built the bundle.

| Bundler              | Default `GhosttyCore.load()`                   | Verified |
| -------------------- | ---------------------------------------------- | -------- |
| Vite (dev and build) | works, emits a hashed asset                    | yes      |
| Bun dev server       | fails, pass `wasmPath`                         | yes      |
| Others               | untested, use `wasmPath` if the default throws | no       |

When the default cannot work, serve the binary yourself and point at it:

```bash
cp node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm public/ghostty-vt.wasm
```

```ts
const core = await GhosttyCore.load({ wasmPath: "/ghostty-vt.wasm" });
```

The binary is also addressable as `@wterm/ghostty/ghostty-vt.wasm`, so a bundler with a URL import can take it directly:

```ts
import wasmPath from "@wterm/ghostty/ghostty-vt.wasm?url";

const core = await GhosttyCore.load({ wasmPath });
```

### Shared Node.js runtime

Node.js can compile the committed bytes once and create multiple terminal cores in the same WASM instance:

```ts
import { readFile } from "node:fs/promises";
import { GhosttyCore, GhosttyRuntime } from "@wterm/ghostty";

const bytes = await readFile(new URL("./ghostty-vt.wasm", import.meta.url));
const runtime = await GhosttyRuntime.load(bytes);
const authority = GhosttyCore.fromRuntime(runtime, { effects: "authority" });
const replica = GhosttyCore.fromRuntime(runtime, { effects: "discard" });
```

`runtime.engineId` is generated from canonical build provenance: the exact Ghostty source tree and commit, snapshot schema digest, adapter ABI and source, feature/build profile, patchset, Zig version, and the committed WASM SHA-256. Snapshot exchange must require exact equality. `GHOSTTY_TERMINAL_PROFILE.term` is the fixed `xterm-256color` value the Host must also place in the child process environment.

URL and `BufferSource` loads verify the raw artifact digest and expose `runtime.artifactVerified === true`. A bare `WebAssembly.Module` cannot be serialized by the Web API, so that path verifies only its embedded source build ID and reports `artifactVerified === false`; passing one is an explicit trust assertion by the caller or module cache.

### Authority primitives

The same core exposes the protocol boundary needed by a remote terminal host:

```ts
const keyBytes = authority.encodeKey({ key: "ArrowUp" });
const pasteBytes = authority.encodePaste("hello\n");
const focusBytes = authority.encodeFocus(true);
authority.resize(80, 24, 800, 408);
const mouseBytes = authority.encodeMouse({
  action: mouseEvent.action,
  button: mouseEvent.button,
  buttons: mouseEvent.buttons,
  modifiers: mouseEvent.modifiers,
  altGraph: mouseEvent.altGraph,
  surface: mouseEvent.surface,
  deltaX: mouseEvent.deltaX,
  deltaY: mouseEvent.deltaY,
  deltaMode: mouseEvent.deltaMode,
});

authority.writeRaw(ptyOutput);
const ptyReplies = authority.drainEffects();
const checkpoint = authority.encodeSnapshot();
const continuation = authority.getContinuation();
```

Browser code should call `ghosttyKeyEventFromDom(event)` once and send the normalized object unchanged. The shared helper preserves physical `KeyboardEvent.code`, logical key, UTF-8 `text`, press/release/repeat action, AltGraph, composition, consumed modifiers, and the reliably observable unshifted code point. It also removes the synthetic Ctrl+Alt pair browsers report for AltGraph text. The Host passes those fields directly to `encodeKey()`; it must not implement a second normalization path.

`encodeMouse()` accepts only the pointer intent needed by the authority; replica `cell` and `viewport` observations are deliberately outside its public input type. It delegates to Ghostty's encoder rather than constructing VT sequences in JavaScript, selects the active authoritative tracking/coordinate modes, recomputes coordinates from surface pixels and the authority's last `resize()` geometry, owns pressed-button state, and deduplicates motion by reported cell. Focus loss, resize, restore, and every mouse mode/format transition reset the relevant encoder state. The session layer must reject stale resize generations before calling it.

`drainEffects()` returns binary `WRITE_PTY` frames in production order. The queue is bounded to 256 frames and 64 KiB; a write that overflows it throws `GhosttyMutationError` with `mutationCommitted: true` and `fatal: true`, increments `getEffectStats()`, and poisons the core. The Host must drain diagnostics, terminate the session, and rebuild from a new PTY. It must never retry that write because Ghostty already applied it.

`encodeSnapshot()` is a point-in-time Ghostty checkpoint that includes the parser continuation. It does not replace the ordered PTY byte stream between checkpoints.

### Passive snapshot restore

Restore decodes the renderable READY prefix synchronously, then exposes one
history PAGE per call. The normal cold-reconnect flow validates FINISH before
applying transport bytes that followed the checkpoint:

```ts
const restore = runtime.beginPassiveRestore(snapshot, {
  effects: "discard",
  maxContinuationBytes: 64 * 1024,
});

await restore.advanceToFinish(); // yields to the event loop between pages
restore.writeRaw(bytesAfterCheckpoint);
const replica = restore.takeCore();
restore.dispose();
```

For a latency-sensitive reconnect, `abandonHistory()` permanently drops the
remaining decoder input before the transport tail is applied:

```ts
const restore = runtime.beginPassiveRestore(snapshot, {
  effects: "discard",
  maxContinuationBytes: 64 * 1024,
});
restore.abandonHistory();
restore.writeRaw(bytesAfterCheckpoint);
const replica = restore.takeCore();
```

`decodeNextHistory()` is the lower-level one-page primitive.
`advanceToFinish({ signal })` converts cancellation into explicit history
abandonment, leaving the READY terminal available for `writeRaw()` and
`takeCore()`. A handle owns the terminal until `takeCore()` succeeds; transfer
is allowed only after FINISH or explicit abandonment and can happen once.
FINISH is accepted only when the bounded snapshot buffer is exhausted, so
trailing bytes and concatenated snapshots fail integrity validation. Explicit
`abandonHistory()` is the sole opt-out: it intentionally discards every
unconsumed snapshot byte together with the remaining history.
Restored terminals are permanently created with `effects: "discard"`, so
continuation replay, history restore, resizing, and later PTY bytes cannot emit
replies to the remote process.

A WASM trap makes restore ownership unknowable. The handle atomically drops its
native pointer, attempts best-effort cleanup, and caches a fatal
`GhosttyRestoreError` with `status: "unknown"`; every later operation throws the
same error and `takeCore()` is forbidden. A zero transfer allocation before a
write and a typed `resizeFailure` remain retryable. A typed `mutationFailure`
leaves the native restore in `failed` phase and must not be retried.

## Architecture

The WASM binary is built from [Eric-Song-Nop/ghostty](https://github.com/Eric-Song-Nop/ghostty) commit `fe317f850c3ab212f6638122c459b9b48b99a016`, based on upstream commit `f2d5758f6305867dc36b36293c6165d8152b853e`. The fork commit fixes upstream's unreachable ANSI DECRQM dispatch and is reviewed in [Eric-Song-Nop/ghostty#1](https://github.com/Eric-Song-Nop/ghostty/pull/1). No build-time source rewrite, third-party npm package, or pre-built binary participates in the build.

```
ghostty (exact Zig dep)  →  wasm_api.zig  →  ghostty-vt.wasm  →  TypeScript runtime
```

The committed `wasm/ghostty-vt.wasm` binary means consumers never need Zig installed. Only maintainers rebuilding the WASM need Zig 0.16.0.

### Rebuilding the WASM

Requires [Zig 0.16.0](https://ziglang.org/download/):

```bash
pnpm --filter @wterm/ghostty rebuild-wasm
```

This fetches the exact Ghostty source via Zig's package manager, generates the embedded source build ID, compiles the export layer to `wasm32-freestanding`, copies the binary to `wasm/`, and generates `engine-manifest.json` plus the TypeScript identity exports. Package tests fail if any source, dependency, generated file, or committed WASM digest is stale.

If the host toolchain cannot build, run the same script in a Linux container:

```bash
pnpm --filter @wterm/ghostty rebuild-wasm:docker
```

### Upgrading ghostty

1. Edit the exact commit URL in `zig/build.zig.zon`
2. Run `zig fetch <new-url>` from the `zig/` directory to get the new hash
3. Update the hash in `build.zig.zon`
4. Run `pnpm --filter @wterm/ghostty rebuild-wasm`; the build generates every engine identity artifact
5. Run the package tests and commit the Zig pin, adapter changes, generated manifest, and WASM together

## Tradeoffs vs built-in core

|               | Built-in (default)      | `@wterm/ghostty`                  |
| ------------- | ----------------------- | --------------------------------- |
| Bundle size   | ~12 KB WASM             | ~600 KB WASM                      |
| VT compliance | Basic VT100/VT220/xterm | Comprehensive                     |
| Unicode       | Single codepoints       | Full grapheme clusters            |
| Dependencies  | None                    | None (WASM built from source)     |
| Setup         | Zero-config             | Requires `@wterm/ghostty` install |

## License

Apache-2.0
