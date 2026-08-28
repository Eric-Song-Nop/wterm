import { describe, expect, it } from "vitest";
import {
  TerminalInputModifier,
  terminalKeyEventFromDom,
} from "../terminal-input.js";

const base = {
  type: "keydown",
  code: "KeyA",
  key: "a",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
};

describe("terminalKeyEventFromDom", () => {
  it("copies physical, logical, text, action, and modifier metadata", () => {
    expect(
      terminalKeyEventFromDom({
        ...base,
        code: "KeyA",
        key: "A",
        shiftKey: true,
        metaKey: true,
        getModifierState: (key) => key === "CapsLock",
      }),
    ).toEqual({
      code: "KeyA",
      key: "A",
      text: "A",
      modifiers:
        TerminalInputModifier.Shift |
        TerminalInputModifier.Super |
        TerminalInputModifier.CapsLock,
      consumedModifiers: TerminalInputModifier.Shift,
      altGraph: false,
      action: "press",
      repeat: false,
      composing: false,
      unshiftedCodepoint: "a".codePointAt(0),
    });
  });

  it("removes browser-synthesized Ctrl+Alt while retaining AltGraph", () => {
    expect(
      terminalKeyEventFromDom({
        ...base,
        code: "KeyQ",
        key: "@",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      }),
    ).toMatchObject({
      code: "KeyQ",
      key: "@",
      text: "@",
      modifiers: 0,
      consumedModifiers: 0,
      altGraph: true,
      unshiftedCodepoint: "@".codePointAt(0),
    });
  });

  it("distinguishes release, repeat, and composition state", () => {
    expect(
      terminalKeyEventFromDom(
        { ...base, type: "keyup", key: "ArrowUp", code: "ArrowUp" },
        true,
      ),
    ).toMatchObject({
      action: "release",
      repeat: false,
      composing: true,
      text: undefined,
      unshiftedCodepoint: 0,
    });
    expect(terminalKeyEventFromDom({ ...base, repeat: true })).toMatchObject({
      action: "repeat",
      repeat: true,
    });
  });

  it("uses zero when a shifted layout value cannot be reversed reliably", () => {
    expect(
      terminalKeyEventFromDom({
        ...base,
        code: "Digit1",
        key: "!",
        shiftKey: true,
      }).unshiftedCodepoint,
    ).toBe(0);
  });
});
