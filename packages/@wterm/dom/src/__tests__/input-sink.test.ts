import { describe, expect, it, vi } from "vitest";
import type {
  InputSink,
  TerminalCore,
  TerminalInputEvent,
  TerminalMouseInputEvent,
} from "@wterm/core";
import { createHandlerInputSink } from "../input-sink.js";

function coreWithModes(
  overrides: Partial<
    Pick<
      TerminalCore,
      | "bracketedPaste"
      | "cursorKeysApp"
      | "focusEvents"
      | "mouseSgr"
      | "mouseTracking"
    >
  > = {},
): TerminalCore {
  return {
    bracketedPaste: () => false,
    cursorKeysApp: () => false,
    focusEvents: () => false,
    mouseSgr: () => false,
    mouseTracking: () => 0,
    ...overrides,
  } as unknown as TerminalCore;
}

function mouse(
  overrides: Partial<TerminalMouseInputEvent> = {},
): TerminalMouseInputEvent {
  return {
    type: "mouse",
    action: "move",
    button: null,
    buttons: 0,
    modifiers: 0,
    altGraph: false,
    surface: { x: 15, y: 15 },
    cell: { column: 1, row: 1 },
    viewport: {
      columns: 80,
      rows: 24,
      width: 800,
      height: 408,
      cellWidth: 10,
      cellHeight: 17,
    },
    ...overrides,
  };
}

describe("createHandlerInputSink", () => {
  it("forwards semantic intent unchanged without consulting replica modes", () => {
    const events: TerminalInputEvent[] = [];
    const output: InputSink = { send: (event) => events.push(event) };
    const replica = coreWithModes({ bracketedPaste: () => true });
    const sink = createHandlerInputSink(output, () => replica);
    const paste = { type: "paste", text: "a\x1b[201~b" } as const;

    expect(sink.send(paste)).toBe(true);
    expect(events).toEqual([paste]);

    const composing = {
      type: "key",
      code: "KeyA",
      key: "Process",
      modifiers: 0,
      consumedModifiers: 0,
      altGraph: false,
      action: "press",
      repeat: false,
      composing: true,
      unshiftedCodepoint: 0,
    } as const;
    expect(sink.send(composing)).toBe(false);
    expect(events.at(-1)).toBe(composing);
  });

  it("preserves legacy raw key, paste, and focus encoding", () => {
    const onData = vi.fn();
    const authority = coreWithModes({
      bracketedPaste: () => true,
      cursorKeysApp: () => true,
      focusEvents: () => true,
    });
    const sink = createHandlerInputSink(onData, () => authority);

    sink.send({
      type: "key",
      code: "ArrowUp",
      key: "ArrowUp",
      modifiers: 0,
      consumedModifiers: 0,
      altGraph: false,
      action: "press",
      repeat: false,
      composing: false,
      unshiftedCodepoint: 0,
    });
    sink.send({ type: "paste", text: "a\x1bb" });
    sink.send({ type: "focus", focused: false });

    expect(onData.mock.calls.map(([value]) => value)).toEqual([
      "\x1bOA",
      "\x1b[200~ab\x1b[201~",
      "\x1b[O",
    ]);
  });

  it("uses replica tracking as semantic dispatch and DOM interception policy", () => {
    let tracking: 0 | 9 | 1000 | 1002 | 1003 = 0;
    const replica = coreWithModes({
      mouseSgr: () => true,
      mouseTracking: () => tracking,
    });
    const semantic = createHandlerInputSink({ send: vi.fn() }, () => replica);
    const raw = createHandlerInputSink(vi.fn(), () => replica);
    const hover = mouse();

    expect(semantic.hoverMotion).toBe(false);
    expect(semantic.acceptsMouse(replica, hover)).toBe(false);
    expect(semantic.shouldInterceptMouse(replica, hover)).toBe(false);

    tracking = 1000;
    expect(semantic.hoverMotion).toBe(false);
    expect(semantic.acceptsMouse(replica, hover)).toBe(false);
    expect(
      semantic.acceptsMouse(
        replica,
        mouse({ action: "press", button: 0, buttons: 1 }),
      ),
    ).toBe(true);

    tracking = 1002;
    expect(semantic.hoverMotion).toBe(false);
    expect(semantic.acceptsMouse(replica, hover)).toBe(false);
    expect(semantic.acceptsMouse(replica, mouse({ buttons: 1 }))).toBe(true);

    tracking = 1003;
    expect(semantic.hoverMotion).toBe(true);
    expect(semantic.acceptsMouse(replica, hover)).toBe(true);
    expect(semantic.shouldInterceptMouse(replica, hover)).toBe(true);
    expect(raw.hoverMotion).toBe(true);
    expect(raw.acceptsMouse(replica, hover)).toBe(true);

    tracking = 9;
    expect(
      raw.acceptsMouse(replica, mouse({ action: "release", button: 0 })),
    ).toBe(false);
    expect(
      raw.acceptsMouse(
        replica,
        mouse({ action: "press", button: 0, buttons: 1 }),
      ),
    ).toBe(true);
    expect(
      raw.acceptsMouse(replica, mouse({ action: "wheel", deltaY: 1 })),
    ).toBe(false);
  });
});
