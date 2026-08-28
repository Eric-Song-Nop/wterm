export const TerminalInputModifier = Object.freeze({
  Shift: 1 << 0,
  Control: 1 << 1,
  Alt: 1 << 2,
  Super: 1 << 3,
  CapsLock: 1 << 4,
  NumLock: 1 << 5,
} as const);

export type TerminalKeyAction = "press" | "release" | "repeat";

export interface TerminalModifierEvent {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?(key: string): boolean;
}

export interface TerminalDomKeyEvent extends TerminalModifierEvent {
  type?: string;
  code: string;
  key: string;
  repeat: boolean;
  isComposing?: boolean;
}

export interface TerminalKeyEvent {
  /** Physical DOM code. An empty value means the browser did not provide one. */
  code: string;
  /** Logical DOM key. */
  key: string;
  /** Committed UTF-8 text for a printable key. */
  text?: string;
  modifiers: number;
  consumedModifiers: number;
  altGraph: boolean;
  action: TerminalKeyAction;
  repeat: boolean;
  composing: boolean;
  /** Unicode scalar before Shift was applied, or 0 when browsers cannot tell. */
  unshiftedCodepoint: number;
}

export interface TerminalKeyInputEvent extends TerminalKeyEvent {
  type: "key";
}

export interface TerminalTextInputEvent {
  type: "text";
  text: string;
  source: "composition" | "input" | "shortcut";
}

export interface TerminalPasteInputEvent {
  type: "paste";
  /** Original clipboard text. The authority applies paste policy and framing. */
  text: string;
}

export interface TerminalFocusInputEvent {
  type: "focus";
  focused: boolean;
}

export interface TerminalMouseViewport {
  columns: number;
  rows: number;
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
}

/** Pointer intent required by an authoritative terminal encoder. */
export interface TerminalMouseIntent {
  action: "press" | "release" | "move" | "wheel";
  /** DOM button number for press/release, otherwise null. */
  button: number | null;
  /** DOM `MouseEvent.buttons` bit mask after this event. */
  buttons: number;
  modifiers: number;
  altGraph: boolean;
  /** CSS pixel position relative to the visible terminal grid. */
  surface: {
    x: number;
    y: number;
  };
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
}

export interface TerminalMouseInputEvent extends TerminalMouseIntent {
  type: "mouse";
  /**
   * Zero-based local replica observation for UI/telemetry only. An authority
   * must derive protocol coordinates again from `surface` and its own modes.
   */
  cell: {
    column: number;
    row: number;
  };
  /** Local replica geometry observed with this event. */
  viewport: TerminalMouseViewport;
}

export interface TerminalResizeInputEvent {
  type: "resize";
  cols: number;
  rows: number;
  /** CSS-pixel width requested for the terminal surface. */
  widthPx: number;
  /** CSS-pixel height requested for the terminal surface. */
  heightPx: number;
}

export type TerminalInputEvent =
  | TerminalKeyInputEvent
  | TerminalTextInputEvent
  | TerminalPasteInputEvent
  | TerminalFocusInputEvent
  | TerminalMouseInputEvent
  | TerminalResizeInputEvent;

/** Receives browser intent without encoding it against replica terminal modes. */
export interface InputSink {
  send(event: TerminalInputEvent): void;
}

export function terminalModifierMaskFromDom(event: TerminalModifierEvent): {
  modifiers: number;
  altGraph: boolean;
} {
  let modifiers = 0;
  if (event.shiftKey) modifiers |= TerminalInputModifier.Shift;
  if (event.ctrlKey) modifiers |= TerminalInputModifier.Control;
  if (event.altKey) modifiers |= TerminalInputModifier.Alt;
  if (event.metaKey) modifiers |= TerminalInputModifier.Super;
  if (event.getModifierState?.("CapsLock"))
    modifiers |= TerminalInputModifier.CapsLock;
  if (event.getModifierState?.("NumLock"))
    modifiers |= TerminalInputModifier.NumLock;

  const altGraph = event.getModifierState?.("AltGraph") ?? false;
  if (altGraph) {
    modifiers &= ~(TerminalInputModifier.Control | TerminalInputModifier.Alt);
  }
  return { modifiers, altGraph };
}

function inferUnshiftedCodepoint(event: TerminalDomKeyEvent): number {
  const characters = Array.from(event.key);
  if (characters.length !== 1) return 0;
  if (!event.shiftKey) return characters[0]!.codePointAt(0) ?? 0;

  // Browser keyboard events do not expose the active layout's unshifted key.
  // ASCII letter casing is the only shifted form we can reverse reliably.
  if (/^[A-Z]$/.test(event.key)) {
    return event.key.toLowerCase().codePointAt(0) ?? 0;
  }
  return 0;
}

/** Normalize a DOM key once at the browser boundary before it crosses a wire. */
export function terminalKeyEventFromDom(
  event: TerminalDomKeyEvent,
  composing = event.isComposing ?? false,
): TerminalKeyEvent {
  const { modifiers, altGraph } = terminalModifierMaskFromDom(event);
  const text = Array.from(event.key).length === 1 ? event.key : undefined;
  const action =
    event.type === "keyup" ? "release" : event.repeat ? "repeat" : "press";
  return {
    code: event.code,
    key: event.key,
    text,
    modifiers,
    consumedModifiers:
      text === undefined ? 0 : modifiers & TerminalInputModifier.Shift,
    altGraph,
    action,
    repeat: event.repeat,
    composing,
    unshiftedCodepoint: inferUnshiftedCodepoint(event),
  };
}
