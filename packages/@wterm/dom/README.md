# @wterm/dom

DOM renderer, input handler, and orchestrator for [wterm](https://github.com/vercel-labs/wterm) — a terminal emulator for the web. No framework required.

Re-exports everything from `@wterm/core`, so this is the only package you need for vanilla JS usage.

## Install

```bash
npm install @wterm/dom
```

## Usage

```html
<div id="terminal"></div>

<script type="module">
  import { WTerm } from "@wterm/dom";
  import "@wterm/dom/css";

  const term = new WTerm(document.getElementById("terminal"));
  await term.init();
</script>
```

The WASM binary is embedded in the package — no extra setup required. To serve it separately instead, pass `wasmUrl`.

## API

### `WTerm`

The main terminal class.

```ts
new WTerm(element: HTMLElement, options?: WTermOptions)
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `cols` | `number` | `80` | Initial column count |
| `rows` | `number` | `24` | Initial row count |
| `core` | `TerminalCore` | — | Pre-constructed core owned and disposed by WTerm |
| `wasmUrl` | `string` | — | Optional URL to serve the WASM binary separately (embedded by default) |
| `autoResize` | `boolean` | `true` | Observe container dimensions. Raw mode resizes locally; semantic mode emits resize intent. |
| `cursorBlink` | `boolean` | `false` | Enable cursor blinking animation |
| `debug` | `boolean` | `false` | Enable debug mode. Exposes a `DebugAdapter` on the instance (`wt.debug`) for inspecting escape sequences, cell data, render performance, and unhandled CSI sequences. |
| `onData` | `(data: string) => void` | — | Legacy raw-input bytes and core responses. When omitted, raw input is echoed locally. Mutually exclusive with `inputSink`. |
| `inputSink` | `InputSink` | — | Semantic browser intent for a remote authority. Mutually exclusive with `onData`. |
| `onTitle` | `(title: string) => void` | — | Called when the terminal title changes |
| `onResize` | `(cols: number, rows: number) => void` | — | Called on resize |
| `onRenderCommit` | `() => void` | — | Called after a successful render and WTerm's synchronous local commit. This does not report browser paint. |

**Methods:**

| Method | Description |
|---|---|
| `init(): Promise<WTerm>` | Load WASM and start rendering |
| `write(data: string \| Uint8Array)` | Write data to the terminal |
| `resize(cols, rows, widthPx?, heightPx?)` | Apply an authoritative grid and optional CSS-pixel surface size without emitting input |
| `adoptCore(core)` | Atomically replace the active core with an already initialized core |
| `focus()` | Focus the terminal element |
| `destroy()` | Dispose the active core and clean up event listeners and DOM |

`adoptCore()` stages the replacement core's first frame outside the live DOM. On success, WTerm takes ownership and disposes the previous core. If validation or rendering fails, the existing core and DOM remain active and the caller retains ownership of the replacement. Adoption does not call `init()`, `onData`, or `onResize`. A viewport following the bottom stays there; otherwise its distance from the bottom is preserved and clamped to the replacement's scroll range.

In raw mode, terminal mouse and focus modes on the local core determine the bytes sent through `onData`. This preserves the existing local-terminal behavior.

For a remote authority, pass `inputSink` instead:

```ts
const term = new WTerm(element, {
  core: replica,
  inputSink: {
    send(event) {
      session.sendInput(event);
    },
  },
});
```

Semantic mode never calls `onData` and never encodes input from replica modes. It emits normalized key press/release/repeat, committed text/IME, original paste text, deduplicated focus transitions, pointer intent, and deduplicated resize requests. In this mode `ResizeObserver` does not mutate the replica or rebuild its renderer. The session orders a resize request, applies it on the Host, and uses `WTerm.resize(cols, rows, widthPx, heightPx)` only when the authoritative state is ready; that explicit apply never feeds the `InputSink` back.

Mouse events include surface pixels plus locally observed cell and viewport geometry. The cell and viewport are hints only: the Host must validate its session resize fence and encode from the authoritative terminal's modes and geometry. A detached replica can receive the same accepted dimensions through `TerminalCore.resize(cols, rows, widthPx, heightPx)` before adoption.

WTerm honors synchronized output mode (CSI `?2026`) by painting the block atomically when the mode closes. Each synchronized block can hold rendering for at most one second from its opening sequence. Ordinary payload does not extend that deadline. If the deadline expires, WTerm resumes painting until a fresh synchronized block begins.

Ordinary writes schedule `requestAnimationFrame` directly. Multiple writes before the frame are coalesced into one render.

`onRenderCommit` observes each successful initial, scheduled, synchronized-output, or adopted-core render after WTerm has finished its synchronous DOM, scroll, title, and response work. Observer errors are ignored so diagnostics cannot disrupt the terminal. The hook does not mean the browser has painted pixels, and omitting it adds no frame or timer scheduling.

When a terminal core supplies `CellData.chars`, the renderer paints that complete grapheme string instead of only the cell's base code point.

When a core supplies OSC 8 metadata through `CellData.linkUri` and `CellData.linkKey`, the renderer groups the covered cells into native anchors. Only absolute HTTP and HTTPS URIs become clickable. Invalid, relative, and executable schemes render as ordinary terminal text.
While hovering an anchor, holding Command on macOS or Control on Windows and Linux reveals its underline and pointer cursor. Plain clicks remain terminal interaction. Command-click, Control-click, or native keyboard activation when an anchor receives focus opens the link. Modified link activation remains available while SGR mouse tracking is active and is not forwarded to the terminal application.

Scrollback normally keeps only the visible rows plus overscan mounted in the DOM. While native text selection is active, the selected range stays mounted so the browser can preserve it. Native browser find and accessibility inspect the mounted window, not every retained history row. Scrolling updates the window, while new output follows the exact bottom only when the terminal was already there.

WTerm owns scrollback anchoring when old history is discarded. The package stylesheet disables browser-native scroll anchoring on the terminal scroller so rollover produces one deterministic adjustment across browsers.

### `WebSocketTransport`

Connect to a PTY backend over WebSocket (re-exported from `@wterm/core`).

```ts
import { WTerm, WebSocketTransport } from "@wterm/dom";

const term = new WTerm(el, { cols: 80, rows: 24 });
await term.init();

const ws = new WebSocketTransport({
  url: "ws://localhost:8080/pty",
  onData: (data) => term.write(data),
});

ws.connect();
term.onData = (data) => ws.send(data);
```

## Themes

Import the stylesheet and apply a theme class to the terminal element:

```js
import "@wterm/dom/css";
```

Built-in themes: `theme-solarized-dark`, `theme-monokai`, `theme-light`. Apply via class name:

```js
element.classList.add("theme-monokai");
```

All colors use CSS custom properties (`--term-fg`, `--term-bg`, `--term-color-0` through `--term-color-15`, etc.) so you can define your own theme with plain CSS.

## License

Apache-2.0
