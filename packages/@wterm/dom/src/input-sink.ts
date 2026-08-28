import {
  TerminalInputModifier,
  type InputSink,
  type TerminalCore,
  type TerminalInputEvent,
  type TerminalKeyEvent,
  type TerminalMouseInputEvent,
} from "@wterm/core";

const NORMAL_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
};

const APP_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "\x1bOA",
  ArrowDown: "\x1bOB",
  ArrowRight: "\x1bOC",
  ArrowLeft: "\x1bOD",
  Home: "\x1bOH",
  End: "\x1bOF",
};

const FIXED_KEYS: Readonly<Record<string, string>> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

export interface HandlerInputSink {
  readonly hoverMotion: boolean;
  send(event: TerminalInputEvent): boolean;
  acceptsMouseMotion(core: TerminalCore | null, buttons: number): boolean;
  acceptsMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean;
  shouldInterceptMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean;
}

class SemanticInputSink implements HandlerInputSink {
  constructor(
    private readonly sink: InputSink,
    private readonly getCore: () => TerminalCore | null,
  ) {}

  get hoverMotion(): boolean {
    return this.acceptsMouseMotion(this.getCore(), 0);
  }

  send(event: TerminalInputEvent): boolean {
    this.sink.send(event);
    // Composition keys remain observable without blocking browser IME.
    return event.type !== "key" || !event.composing;
  }

  acceptsMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean {
    const tracking = core?.mouseTracking?.() ?? 0;
    if (tracking === 0) return false;
    if (tracking === 9 && event.action !== "press") return false;
    if (event.action === "move") {
      return this.acceptsMouseMotion(core, event.buttons);
    }
    if (event.action === "press" || event.action === "release") {
      return event.button !== null && event.button >= 0 && event.button <= 4;
    }
    if (event.action === "wheel") {
      return (event.deltaX ?? 0) !== 0 || (event.deltaY ?? 0) !== 0;
    }
    return true;
  }

  acceptsMouseMotion(core: TerminalCore | null, buttons: number): boolean {
    const tracking = core?.mouseTracking?.() ?? 0;
    return tracking === 1003 || (tracking === 1002 && buttons !== 0);
  }

  shouldInterceptMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean {
    return this.acceptsMouse(core, event);
  }
}

class RawInputSink implements HandlerInputSink {
  constructor(
    private readonly onData: (data: string) => void,
    private readonly getCore: () => TerminalCore | null,
  ) {}

  get hoverMotion(): boolean {
    return this.acceptsMouseMotion(this.getCore(), 0);
  }

  acceptsMouseMotion(core: TerminalCore | null, buttons: number): boolean {
    if (!core?.mouseSgr?.()) return false;
    const tracking = core.mouseTracking?.() ?? 0;
    return tracking === 1003 || (tracking === 1002 && (buttons & 7) !== 0);
  }

  send(event: TerminalInputEvent): boolean {
    switch (event.type) {
      case "key":
        return this.sendKey(event);
      case "text":
        this.onData(event.text);
        return true;
      case "paste":
        return this.sendPaste(event.text);
      case "focus":
        if (!this.getCore()?.focusEvents?.()) return false;
        this.onData(event.focused ? "\x1b[I" : "\x1b[O");
        return true;
      case "resize":
        // ResizeObserver applies raw-mode resizes directly through WTerm.
        return false;
      case "mouse":
        return this.sendMouse(event);
    }
  }

  shouldInterceptMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean {
    if (!core?.mouseSgr?.()) return false;
    const tracking = core.mouseTracking?.() ?? 0;
    if (tracking === 0) return false;
    if (tracking === 9) return event.action === "press";
    if (event.action !== "move") return true;
    return this.acceptsMouseMotion(core, event.buttons);
  }

  acceptsMouse(
    core: TerminalCore | null,
    event: TerminalMouseInputEvent,
  ): boolean {
    if (!this.shouldInterceptMouse(core, event)) return false;
    if (
      (event.action === "press" || event.action === "release") &&
      (event.button === null || event.button > 2)
    ) {
      return false;
    }
    if (event.action === "wheel") {
      return (event.deltaX ?? 0) !== 0 || (event.deltaY ?? 0) !== 0;
    }
    return true;
  }

  private sendKey(event: TerminalKeyEvent): boolean {
    if (event.action === "release" || event.composing) return false;
    const sequence = this.keyToSequence(event);
    if (sequence) this.onData(sequence);
    // Raw mode historically prevented every non-composing keydown.
    return true;
  }

  private sendPaste(text: string): boolean {
    if (this.getCore()?.bracketedPaste()) {
      // Clipboard ESC bytes could otherwise inject the closing frame.
      const safe = text.replace(/\x1b/g, "");
      this.onData("\x1b[200~" + safe + "\x1b[201~");
    } else {
      this.onData(text);
    }
    return true;
  }

  private sendMouse(event: TerminalMouseInputEvent): boolean {
    const core = this.getCore();
    if (!this.acceptsMouse(core, event)) return false;

    const shift = event.modifiers & TerminalInputModifier.Shift ? 4 : 0;
    const alt = event.modifiers & TerminalInputModifier.Alt ? 8 : 0;
    const control = event.modifiers & TerminalInputModifier.Control ? 16 : 0;
    const modifiers = shift | alt | control;
    let code: number;
    let final = "M";
    if (event.action === "wheel") {
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX === 0) return false;
        code = (deltaX < 0 ? 66 : 67) | modifiers;
      } else {
        if (deltaY === 0) return false;
        code = (deltaY < 0 ? 64 : 65) | modifiers;
      }
    } else {
      const button =
        event.action === "move"
          ? event.buttons & 4
            ? 1
            : event.buttons & 2
              ? 2
              : event.buttons & 1
                ? 0
                : 3
          : event.button === 1
            ? 1
            : event.button === 2
              ? 2
              : 0;
      code = button | modifiers | (event.action === "move" ? 32 : 0);
      if (event.action === "release") final = "m";
    }

    this.onData(
      `\x1b[<${code};${event.cell.column + 1};${event.cell.row + 1}${final}`,
    );
    return true;
  }

  private keyToSequence(event: TerminalKeyEvent): string | null {
    const control = (event.modifiers & TerminalInputModifier.Control) !== 0;
    const alt = (event.modifiers & TerminalInputModifier.Alt) !== 0;
    const meta = (event.modifiers & TerminalInputModifier.Super) !== 0;
    const shift = (event.modifiers & TerminalInputModifier.Shift) !== 0;

    if (control && !alt && !meta) {
      if (event.key.length === 1) {
        const code = event.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
      }
      if (event.key === "[") return "\x1b";
      if (event.key === "\\") return "\x1c";
      if (event.key === "]") return "\x1d";
      if (event.key === "^") return "\x1e";
      if (event.key === "_") return "\x1f";
    }

    if (event.key === "Enter" && shift) return "\x1b[13;2u";
    if (event.key === "Tab" && shift) return "\x1b[Z";

    const fixed = FIXED_KEYS[event.key];
    if (fixed) return alt ? "\x1b" + fixed : fixed;

    const navMap = this.getCore()?.cursorKeysApp() ? APP_KEYS : NORMAL_KEYS;
    const nav = navMap[event.key];
    if (nav) return alt ? "\x1b" + nav : nav;

    if (event.text !== undefined && !control && !meta) {
      return alt ? "\x1b" + event.text : event.text;
    }
    return null;
  }
}

export function createHandlerInputSink(
  output: ((data: string) => void) | InputSink,
  getCore: () => TerminalCore | null,
): HandlerInputSink {
  return typeof output === "function"
    ? new RawInputSink(output, getCore)
    : new SemanticInputSink(output, getCore);
}
