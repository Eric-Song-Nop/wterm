import {
  terminalKeyEventFromDom,
  terminalModifierMaskFromDom,
  type InputSink,
  type TerminalCore,
  type TerminalInputEvent,
  type TerminalMouseInputEvent,
} from "@wterm/core";
import { isLinkActivationModifier } from "./hyperlink.js";
import { createHandlerInputSink, type HandlerInputSink } from "./input-sink.js";

const SUPPORTED_MOUSE_BUTTONS = 0b1_1111;

export class InputHandler {
  private readonly element: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly inputSink: HandlerInputSink;
  private readonly getCore: () => TerminalCore | null;
  private readonly getCellSize: () => {
    charWidth: number;
    rowHeight: number;
  } | null;
  private readonly nativeKeyReleases = new Set<string>();
  private composing = false;
  private pendingCompositionCommit: string | null = null;
  private mouseButtons = 0;
  private focused = false;

  private readonly _onKeyDown: (event: KeyboardEvent) => void;
  private readonly _onKeyUp: (event: KeyboardEvent) => void;
  private readonly _onPaste: (event: ClipboardEvent) => void;
  private readonly _onCompositionStart: () => void;
  private readonly _onCompositionEnd: (event: CompositionEvent) => void;
  private readonly _onInput: () => void;
  private readonly _onFocus: () => void;
  private readonly _onBlur: () => void;
  private readonly _onMouseDown: (event: MouseEvent) => void;
  private readonly _onElementMouseMove: (event: MouseEvent) => void;
  private readonly _onMouseMove: (event: MouseEvent) => void;
  private readonly _onMouseUp: (event: MouseEvent) => void;
  private readonly _onWheel: (event: WheelEvent) => void;

  constructor(
    element: HTMLElement,
    onData: (data: string) => void,
    getCore: () => TerminalCore | null,
    getCellSize?: () => { charWidth: number; rowHeight: number } | null,
  );
  constructor(
    element: HTMLElement,
    inputSink: InputSink,
    getCore: () => TerminalCore | null,
    getCellSize?: () => { charWidth: number; rowHeight: number } | null,
  );
  constructor(
    element: HTMLElement,
    output: ((data: string) => void) | InputSink,
    getCore: () => TerminalCore | null,
    getCellSize: () => { charWidth: number; rowHeight: number } | null = () =>
      null,
  ) {
    this.element = element;
    this.getCore = getCore;
    this.getCellSize = getCellSize;
    this.inputSink = createHandlerInputSink(output, getCore);

    this.textarea = document.createElement("textarea");
    this.textarea.setAttribute("autocapitalize", "off");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.setAttribute("spellcheck", "false");
    this.textarea.setAttribute("enterkeyhint", "send");
    this.textarea.setAttribute("tabindex", "0");
    this.textarea.setAttribute("aria-hidden", "true");
    const style = this.textarea.style;
    style.position = "absolute";
    style.left = "-9999px";
    style.top = "0";
    style.width = "1px";
    style.height = "1px";
    style.opacity = "0";
    style.overflow = "hidden";
    style.border = "0";
    style.padding = "0";
    style.margin = "0";
    style.outline = "none";
    style.resize = "none";
    style.pointerEvents = "none";
    style.caretColor = "transparent";
    style.color = "transparent";
    style.background = "transparent";
    element.appendChild(this.textarea);

    this._onKeyDown = this.handleKeyDown.bind(this);
    this._onKeyUp = this.handleKeyUp.bind(this);
    this._onPaste = this.handlePaste.bind(this);
    this._onCompositionStart = this.handleCompositionStart.bind(this);
    this._onCompositionEnd = this.handleCompositionEnd.bind(this);
    this._onInput = this.handleInput.bind(this);
    this._onFocus = () => {
      if (this.focused) return;
      this.focused = true;
      this.element.classList.add("focused");
      this.inputSink.send({ type: "focus", focused: true });
    };
    this._onBlur = () => {
      this.nativeKeyReleases.clear();
      this.pendingCompositionCommit = null;
      this.composing = false;
      if (!this.focused) return;
      this.focused = false;
      this.element.classList.remove("focused");
      this.stopMouseCapture();
      this.inputSink.send({ type: "focus", focused: false });
    };
    this._onMouseDown = (event) => this.handleMouse(event, "press");
    this._onElementMouseMove = (event) => {
      if (this.mouseButtons === 0 && this.inputSink.hoverMotion) {
        this.handleMouse(event, "move");
      }
    };
    this._onMouseMove = (event) => {
      if (
        this.mouseButtons !== 0 &&
        this.inputSink.acceptsMouseMotion(
          this.getCore(),
          event.buttons & SUPPORTED_MOUSE_BUTTONS,
        )
      ) {
        this.handleMouse(event, "move");
      }
    };
    this._onMouseUp = (event) => {
      if (this.mouseButtons === 0) return;
      this.handleMouse(event, "release");
      this.mouseButtons = event.buttons & SUPPORTED_MOUSE_BUTTONS;
      if (this.mouseButtons === 0) this.stopMouseCapture();
    };
    this._onWheel = (event) => this.handleMouse(event, "wheel");

    this.textarea.addEventListener("keydown", this._onKeyDown);
    this.textarea.addEventListener("keyup", this._onKeyUp);
    this.textarea.addEventListener("paste", this._onPaste as EventListener);
    this.textarea.addEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.addEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.addEventListener("input", this._onInput);
    this.textarea.addEventListener("focus", this._onFocus);
    this.textarea.addEventListener("blur", this._onBlur);
    this.element.addEventListener("mousedown", this._onMouseDown);
    this.element.addEventListener("mousemove", this._onElementMouseMove);
    this.element.addEventListener("wheel", this._onWheel, { passive: false });
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  destroy(): void {
    this.textarea.removeEventListener("keydown", this._onKeyDown);
    this.textarea.removeEventListener("keyup", this._onKeyUp);
    this.textarea.removeEventListener("paste", this._onPaste as EventListener);
    this.textarea.removeEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.removeEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.removeEventListener("input", this._onInput);
    this.textarea.removeEventListener("focus", this._onFocus);
    this.textarea.removeEventListener("blur", this._onBlur);
    this.element.removeEventListener("mousedown", this._onMouseDown);
    this.element.removeEventListener("mousemove", this._onElementMouseMove);
    this.stopMouseCapture();
    this.element.removeEventListener("wheel", this._onWheel);
    this.element.classList.remove("focused");
    this.nativeKeyReleases.clear();
    this.pendingCompositionCommit = null;
    this.textarea.remove();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const composing = this.composing || event.isComposing;
    if (!composing) this.pendingCompositionCommit = null;
    if (!composing && this.handleNativeShortcut(event)) return;

    const input: TerminalInputEvent = {
      type: "key",
      ...terminalKeyEventFromDom(event, composing),
    };
    if (this.inputSink.send(input)) event.preventDefault();
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const token = this.keyToken(event);
    if (this.nativeKeyReleases.delete(token)) return;

    const input: TerminalInputEvent = {
      type: "key",
      ...terminalKeyEventFromDom(event, this.composing || event.isComposing),
    };
    if (this.inputSink.send(input)) event.preventDefault();
  }

  private handleNativeShortcut(event: KeyboardEvent): boolean {
    if ((event.metaKey || event.ctrlKey) && event.key === "c") {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        this.nativeKeyReleases.add(this.keyToken(event));
        return true;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "v") {
      this.nativeKeyReleases.add(this.keyToken(event));
      this.textarea.focus();
      return true;
    }
    if (!event.metaKey || event.ctrlKey) return false;

    this.nativeKeyReleases.add(this.keyToken(event));
    if (event.key === "Backspace") {
      event.preventDefault();
      this.inputSink.send({
        type: "text",
        text: "\x15",
        source: "shortcut",
      });
    } else if (event.key === "a") {
      event.preventDefault();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(this.element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    return true;
  }

  private keyToken(event: KeyboardEvent): string {
    return event.code || event.key;
  }

  private handlePaste(event: ClipboardEvent): void {
    event.preventDefault();
    this.pendingCompositionCommit = null;
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    this.inputSink.send({ type: "paste", text });
  }

  private handleCompositionStart(): void {
    this.composing = true;
    this.pendingCompositionCommit = null;
  }

  private handleCompositionEnd(event: CompositionEvent): void {
    this.composing = false;
    this.pendingCompositionCommit = event.data || null;
    if (event.data) {
      this.inputSink.send({
        type: "text",
        text: event.data,
        source: "composition",
      });
    }
    this.textarea.value = "";
  }

  private handleInput(): void {
    if (this.composing) return;
    const value = this.textarea.value;
    const compositionCommit = this.pendingCompositionCommit;
    // Only the next input may mirror compositionend; consuming the candidate
    // here prevents a later equal, independently typed value from being lost.
    this.pendingCompositionCommit = null;
    this.textarea.value = "";
    if (compositionCommit !== null && value === compositionCommit) return;
    if (!value) return;
    this.inputSink.send({ type: "text", text: value, source: "input" });
  }

  private handleMouse(
    event: MouseEvent | WheelEvent,
    action: TerminalMouseInputEvent["action"],
  ): void {
    if (
      action === "press" &&
      isLinkActivationModifier(
        event,
        this.element.ownerDocument.defaultView?.navigator ?? navigator,
      ) &&
      event.target instanceof Element &&
      event.target.closest(".term-link")
    ) {
      return;
    }
    if (action === "press" && event.shiftKey) return;

    const core = this.getCore();
    const position = this.resolveMousePosition(event, core);
    if (!position) return;
    const { modifiers, altGraph } = terminalModifierMaskFromDom(event);
    const observedButtons = event.buttons & SUPPORTED_MOUSE_BUTTONS;
    const buttons =
      action === "press"
        ? observedButtons || this.buttonMask(event.button)
        : observedButtons;
    const input: TerminalMouseInputEvent = {
      type: "mouse",
      action,
      button: action === "press" || action === "release" ? event.button : null,
      buttons,
      modifiers,
      altGraph,
      ...position,
      ...(action === "wheel"
        ? {
            deltaX: (event as WheelEvent).deltaX,
            deltaY: (event as WheelEvent).deltaY,
            deltaMode: (event as WheelEvent).deltaMode,
          }
        : undefined),
    };

    const accepted = this.inputSink.acceptsMouse(core, input);
    if (!accepted) return;
    if (action === "press") {
      this.textarea.focus({ preventScroll: true });
      if (!this.focused) this._onFocus();
    }
    const emitted = this.inputSink.send(input);
    if (action === "press" && emitted) {
      this.mouseButtons = buttons;
      const view = this.element.ownerDocument.defaultView;
      view?.addEventListener("mousemove", this._onMouseMove);
      view?.addEventListener("mouseup", this._onMouseUp);
    }
    if (emitted && this.inputSink.shouldInterceptMouse(core, input)) {
      event.preventDefault();
    }
  }

  private resolveMousePosition(
    event: MouseEvent | WheelEvent,
    core: TerminalCore | null,
  ): Pick<TerminalMouseInputEvent, "surface" | "cell" | "viewport"> | null {
    if (!core) return null;
    const columns = core.getCols();
    const rows = core.getRows();
    if (columns <= 0 || rows <= 0) return null;

    const view = this.element.ownerDocument.defaultView;
    if (!view) return null;
    const viewportRow = this.element.querySelector<HTMLElement>(
      ".term-row:not(.term-scrollback-row)",
    );
    const hostRect = this.element.getBoundingClientRect();
    const rowRect = viewportRow?.getBoundingClientRect();
    const measuredCell = this.getCellSize();
    let left: number;
    let top: number;
    let cellWidth: number;
    let cellHeight: number;
    if (rowRect && measuredCell) {
      left = rowRect.left;
      top = rowRect.top;
      cellWidth = measuredCell.charWidth;
      cellHeight = measuredCell.rowHeight;
    } else {
      const style = view.getComputedStyle(this.element);
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderBottom = parseFloat(style.borderBottomWidth) || 0;
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      left = rowRect?.left ?? hostRect.left + borderLeft + paddingLeft;
      top = rowRect?.top ?? hostRect.top + borderTop + paddingTop;
      cellWidth =
        (hostRect.width -
          borderLeft -
          borderRight -
          paddingLeft -
          paddingRight) /
        columns;
      cellHeight =
        (hostRect.height -
          borderTop -
          borderBottom -
          paddingTop -
          paddingBottom) /
        rows;
    }
    if (
      !Number.isFinite(cellWidth) ||
      !Number.isFinite(cellHeight) ||
      cellWidth <= 0 ||
      cellHeight <= 0
    ) {
      return null;
    }

    const x = event.clientX - left;
    const y = event.clientY - top;
    return {
      surface: { x, y },
      cell: {
        column: Math.max(0, Math.min(columns - 1, Math.floor(x / cellWidth))),
        row: Math.max(0, Math.min(rows - 1, Math.floor(y / cellHeight))),
      },
      viewport: {
        columns,
        rows,
        width: cellWidth * columns,
        height: cellHeight * rows,
        cellWidth,
        cellHeight,
      },
    };
  }

  private buttonMask(button: number): number {
    if (button === 0) return 1;
    if (button === 1) return 4;
    if (button === 2) return 2;
    if (button === 3) return 8;
    if (button === 4) return 16;
    return 0;
  }

  private stopMouseCapture(): void {
    this.mouseButtons = 0;
    const view = this.element.ownerDocument.defaultView;
    view?.removeEventListener("mousemove", this._onMouseMove);
    view?.removeEventListener("mouseup", this._onMouseUp);
  }
}
