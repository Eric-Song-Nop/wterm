import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputSink, TerminalCore, TerminalInputEvent } from "@wterm/core";
import { InputHandler } from "../input.js";

describe("InputHandler semantic input", () => {
  let container: HTMLDivElement;
  let events: TerminalInputEvent[];
  let handler: InputHandler;
  let tracking: 0 | 1000 | 1002 | 1003;
  let core: TerminalCore;

  beforeEach(() => {
    container = document.createElement("div");
    container.style.padding = "0";
    container.style.border = "0";
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 10, top: 20, width: 800, height: 400 }),
    });
    const viewportRow = document.createElement("div");
    viewportRow.className = "term-row";
    Object.defineProperty(viewportRow, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 800, height: 10 }),
    });
    container.appendChild(viewportRow);
    document.body.appendChild(container);
    events = [];
    tracking = 0;
    core = {
      getCols: () => 80,
      getRows: () => 40,
      mouseTracking: () => tracking,
      mouseSgr: () => false,
      focusEvents: () => false,
    } as unknown as TerminalCore;
    const sink: InputSink = { send: (event) => events.push(event) };
    handler = new InputHandler(
      container,
      sink,
      () => core,
      () => ({
        charWidth: 10,
        rowHeight: 10,
      }),
    );
  });

  afterEach(() => {
    handler.destroy();
    container.remove();
    window.getSelection()?.removeAllRanges();
  });

  function textarea(): HTMLTextAreaElement {
    return container.querySelector("textarea")!;
  }

  it("emits normalized press, repeat, and release without replica encoding", () => {
    const press = new KeyboardEvent("keydown", {
      code: "KeyQ",
      key: "@",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    vi.spyOn(press, "getModifierState").mockImplementation(
      (key) => key === "AltGraph",
    );
    textarea().dispatchEvent(press);
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyQ",
        key: "@",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea().dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "KeyQ",
        key: "@",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(events).toEqual([
      {
        type: "key",
        code: "KeyQ",
        key: "@",
        text: "@",
        modifiers: 0,
        consumedModifiers: 0,
        altGraph: true,
        action: "press",
        repeat: false,
        composing: false,
        unshiftedCodepoint: 64,
      },
      expect.objectContaining({
        type: "key",
        action: "repeat",
        repeat: true,
      }),
      expect.objectContaining({
        type: "key",
        action: "release",
        repeat: false,
      }),
    ]);
    expect(press.defaultPrevented).toBe(true);
  });

  it("observes composing keys without blocking IME and emits committed text", () => {
    textarea().dispatchEvent(new CompositionEvent("compositionstart"));
    const key = new KeyboardEvent("keydown", {
      code: "KeyA",
      key: "Process",
      bubbles: true,
      cancelable: true,
    });
    textarea().dispatchEvent(key);
    textarea().value = "中";
    textarea().dispatchEvent(
      new CompositionEvent("compositionend", { data: "中" }),
    );
    // Some browsers restore the committed value before the trailing input.
    textarea().value = "中";
    textarea().dispatchEvent(new InputEvent("input"));

    expect(events).toEqual([
      expect.objectContaining({
        type: "key",
        code: "KeyA",
        key: "Process",
        composing: true,
      }),
      { type: "text", text: "中", source: "composition" },
    ]);
    expect(key.defaultPrevented).toBe(false);

    textarea().value = "文";
    textarea().dispatchEvent(new InputEvent("input"));
    expect(events.at(-1)).toEqual({
      type: "text",
      text: "文",
      source: "input",
    });
  });

  it("only suppresses the matching input immediately after a composition commit", () => {
    textarea().dispatchEvent(new CompositionEvent("compositionstart"));
    textarea().dispatchEvent(
      new CompositionEvent("compositionend", { data: "中" }),
    );
    textarea().value = "文";
    textarea().dispatchEvent(new InputEvent("input"));

    textarea().value = "中";
    textarea().dispatchEvent(new InputEvent("input"));

    expect(events).toEqual([
      { type: "text", text: "中", source: "composition" },
      { type: "text", text: "文", source: "input" },
      { type: "text", text: "中", source: "input" },
    ]);
  });

  it("preserves input after an empty or cancelled composition", () => {
    textarea().dispatchEvent(new CompositionEvent("compositionstart"));
    textarea().value = "draft";
    textarea().dispatchEvent(
      new CompositionEvent("compositionend", { data: "" }),
    );
    textarea().value = "real";
    textarea().dispatchEvent(new InputEvent("input"));

    expect(events).toEqual([{ type: "text", text: "real", source: "input" }]);
  });

  it("deduplicates each composition round independently", () => {
    for (const text of ["甲", "乙"]) {
      textarea().dispatchEvent(new CompositionEvent("compositionstart"));
      textarea().dispatchEvent(
        new CompositionEvent("compositionend", { data: text }),
      );
      textarea().value = text;
      textarea().dispatchEvent(new InputEvent("input"));
    }

    expect(events).toEqual([
      { type: "text", text: "甲", source: "composition" },
      { type: "text", text: "乙", source: "composition" },
    ]);
  });

  it("sends original paste text without consulting bracketed-paste mode", () => {
    const paste = new Event("paste", {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "safe\x1b[201~raw" },
    });
    textarea().dispatchEvent(paste);

    expect(events).toEqual([{ type: "paste", text: "safe\x1b[201~raw" }]);
    expect(paste.defaultPrevented).toBe(true);
  });

  it("deduplicates focus transitions and ignores replica focus mode", () => {
    textarea().dispatchEvent(new FocusEvent("focus"));
    textarea().dispatchEvent(new FocusEvent("focus"));
    textarea().dispatchEvent(new FocusEvent("blur"));
    textarea().dispatchEvent(new FocusEvent("blur"));

    expect(events).toEqual([
      { type: "focus", focused: true },
      { type: "focus", focused: false },
    ]);
  });

  it("emits surface intent while treating replica tracking as a UX hint", () => {
    tracking = 1002;
    const press = new MouseEvent("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 85,
      clientY: 65,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(press);
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        buttons: 1,
        clientX: 105,
        clientY: 75,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        button: 0,
        buttons: 0,
        clientX: 105,
        clientY: 75,
      }),
    );
    const wheel = new WheelEvent("wheel", {
      deltaX: -4,
      deltaY: 2,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: 105,
      clientY: 75,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(wheel);

    expect(events.filter((event) => event.type === "mouse")).toEqual([
      expect.objectContaining({
        type: "mouse",
        action: "press",
        button: 0,
        buttons: 1,
        modifiers: 2,
        surface: { x: 75, y: 45 },
        cell: { column: 7, row: 4 },
        viewport: {
          columns: 80,
          rows: 40,
          width: 800,
          height: 400,
          cellWidth: 10,
          cellHeight: 10,
        },
      }),
      expect.objectContaining({
        type: "mouse",
        action: "move",
        button: null,
        buttons: 1,
        surface: { x: 95, y: 55 },
      }),
      expect.objectContaining({
        type: "mouse",
        action: "release",
        button: 0,
        buttons: 0,
      }),
      expect.objectContaining({
        type: "mouse",
        action: "wheel",
        button: null,
        deltaX: -4,
        deltaY: 2,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      }),
    ]);
    expect(press.defaultPrevented).toBe(true);
    expect(wheel.defaultPrevented).toBe(true);

    tracking = 1003;
    const hover = new MouseEvent("mousemove", {
      buttons: 0,
      clientX: 115,
      clientY: 85,
      cancelable: true,
    });
    container.dispatchEvent(hover);
    expect(hover.defaultPrevented).toBe(true);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "mouse",
        action: "move",
        buttons: 0,
      }),
    );

    tracking = 1002;
    const tracked = new MouseEvent("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 85,
      clientY: 65,
      cancelable: true,
    });
    container.dispatchEvent(tracked);
    expect(tracked.defaultPrevented).toBe(true);
  });

  it("gates semantic motion by tracking mode without coalescing browser events", () => {
    const move = (buttons: number, x: number) =>
      new MouseEvent("mousemove", {
        buttons,
        clientX: x,
        clientY: 65,
        cancelable: true,
      });
    const press = () =>
      container.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          buttons: 1,
          clientX: 85,
          clientY: 65,
          cancelable: true,
        }),
      );
    const release = () =>
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          button: 0,
          buttons: 0,
          clientX: 105,
          clientY: 65,
        }),
      );
    const actions = () =>
      events
        .filter((event) => event.type === "mouse")
        .map((event) => event.action);

    container.dispatchEvent(move(0, 85));
    container.dispatchEvent(move(0, 95));
    expect(actions()).toEqual([]);

    tracking = 1000;
    press();
    window.dispatchEvent(move(1, 95));
    window.dispatchEvent(move(1, 105));
    release();
    expect(actions()).toEqual(["press", "release"]);

    events = [];
    tracking = 1002;
    container.dispatchEvent(move(0, 85));
    press();
    window.dispatchEvent(move(1, 95));
    window.dispatchEvent(move(1, 105));
    release();
    expect(actions()).toEqual(["press", "move", "move", "release"]);

    events = [];
    tracking = 1003;
    container.dispatchEvent(move(0, 85));
    container.dispatchEvent(move(0, 95));
    expect(actions()).toEqual(["move", "move"]);
  });

  it("keeps paste and Meta shortcuts on their native paths", () => {
    const pasteShortcut = new KeyboardEvent("keydown", {
      code: "KeyV",
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea().dispatchEvent(pasteShortcut);
    textarea().dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "KeyV",
        key: "v",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(events).toEqual([{ type: "focus", focused: true }]);
    events = [];

    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Backspace",
        key: "Backspace",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea().dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "Backspace",
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(events).toEqual([
      { type: "text", text: "\x15", source: "shortcut" },
    ]);
  });

  it("clears native shortcut releases on blur", () => {
    textarea().dispatchEvent(new FocusEvent("focus"));
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyV",
        key: "v",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea().dispatchEvent(new FocusEvent("blur"));
    events = [];

    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyV",
        key: "v",
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea().dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "KeyV",
        key: "v",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(
      events
        .filter((event) => event.type === "key")
        .map((event) => event.action),
    ).toEqual(["press", "release"]);
  });

  it("removes element, textarea, and captured-window listeners on destroy", () => {
    const input = textarea();
    container.dispatchEvent(
      new MouseEvent("mousedown", {
        button: 0,
        buttons: 1,
        clientX: 85,
        clientY: 65,
      }),
    );
    handler.destroy();
    events = [];

    input.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", key: "a" }),
    );
    input.dispatchEvent(new FocusEvent("focus"));
    container.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 1, clientX: 85, clientY: 65 }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        buttons: 1,
        clientX: 105,
        clientY: 75,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        button: 0,
        buttons: 0,
        clientX: 105,
        clientY: 75,
      }),
    );

    expect(events).toEqual([]);
  });
});
