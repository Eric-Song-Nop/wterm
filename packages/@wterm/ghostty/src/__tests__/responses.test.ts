import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GhosttyCore, type GhosttyOptions } from "../ghostty-core.js";

/**
 * Runs against the real committed wasm: the responses are produced by the Zig
 * stream handler, so a mocked core cannot observe them.
 */
const WASM_URL = "https://wterm.test/ghostty-vt.wasm";
const wasmBytes = readFileSync(
  fileURLToPath(new URL("../../wasm/ghostty-vt.wasm", import.meta.url)),
);

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === WASM_URL) {
      return new Response(wasmBytes, {
        headers: { "content-type": "application/wasm" },
      });
    }
    return realFetch(input as RequestInfo);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function newCore(cols = 20, rows = 4, options: GhosttyOptions = {}) {
  const core = await GhosttyCore.load({ wasmPath: WASM_URL, ...options });
  core.init(cols, rows);
  return core;
}

function drain(core: GhosttyCore): string[] {
  const out: string[] = [];
  for (;;) {
    const response = core.getResponse();
    if (response === null) break;
    out.push(response);
  }
  return out;
}

describe("GhosttyCore terminal responses", () => {
  it("answers a cursor position report", async () => {
    const core = await newCore();
    core.writeString("ab\x1b[6n");
    expect(drain(core)).toEqual(["\x1b[1;3R"]);
  });

  it("answers primary device attributes", async () => {
    const core = await newCore();
    core.writeString("\x1b[c");
    expect(drain(core)).toEqual(["\x1b[?62;22c"]);
  });

  it("uses one fixed authority profile for terminal capability queries", async () => {
    const authority = await newCore();
    authority.resize(20, 4, 200, 80);
    const queries =
      "\x1b[c" +
      "\x1b[>c" +
      "\x1b[=c" +
      "\x1b[5n" +
      "\x1b[6n" +
      "\x1b[?2026$p" +
      "\x1b[14t" +
      "\x1b[16t" +
      "\x1b[18t" +
      "\x1b[>q" +
      "\x1b[?996n" +
      "\x1b]10;?\x1b\\" +
      "\x1b]11;?\x1b\\" +
      "\x1bP+q524742\x1b\\" +
      "\x1bP+q544E\x1b\\" +
      "\x1b[?u";

    authority.writeString(queries);
    expect(drain(authority)).toEqual([
      "\x1b[?62;22c",
      "\x1b[>1;0;0c",
      "\x1bP!|00000000\x1b\\",
      "\x1b[0n",
      "\x1b[1;1R",
      "\x1b[?2026;2$y",
      "\x1b[4;80;200t",
      "\x1b[6;20;10t",
      "\x1b[8;4;20t",
      "\x1bP>|wterm 0.3.4\x1b\\",
      "\x1b[?997;1n",
      "\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      "\x1bP1+r524742=38\x1b\\",
      "\x1bP1+r544E=787465726D2D323536636F6C6F72\x1b\\",
      "\x1b[?0u",
    ]);

    const replica = await newCore(20, 4, { effects: "discard" });
    replica.resize(20, 4, 200, 80);
    replica.writeString(queries);
    expect(drain(replica)).toEqual([]);
  });

  it("reports a mode from the same state the set path writes", async () => {
    const core = await newCore();
    core.writeString("\x1b[?2026$p");
    core.writeString("\x1b[?2026h\x1b[?2026$p");
    core.writeString("\x1b[?2026l\x1b[?2026$p");
    expect(drain(core)).toEqual([
      "\x1b[?2026;2$y",
      "\x1b[?2026;1$y",
      "\x1b[?2026;2$y",
    ]);
  });

  it("exposes synchronized output state and generations", async () => {
    const core = await newCore();
    expect(core.synchronizedOutput?.()).toBe(false);
    expect(core.synchronizedOutputGeneration?.()).toBe(0);

    core.writeString("\x1b[?2026h");
    expect(core.synchronizedOutput?.()).toBe(true);
    expect(core.synchronizedOutputGeneration?.()).toBe(1);

    core.writeString("\x1b[?2026h");
    expect(core.synchronizedOutputGeneration?.()).toBe(1);

    core.writeString("\x1b[?2026l");
    expect(core.synchronizedOutput?.()).toBe(false);
    expect(core.synchronizedOutputGeneration?.()).toBe(1);

    core.writeString("\x1b[?2026h");
    expect(core.synchronizedOutput?.()).toBe(true);
    expect(core.synchronizedOutputGeneration?.()).toBe(2);

    core.writeString("\x1b[?2026s\x1b[?2026l\x1b[?2026r");
    expect(core.synchronizedOutput?.()).toBe(true);
    expect(core.synchronizedOutputGeneration?.()).toBe(3);
  });

  it("answers known and unknown ANSI-mode DECRQM queries", async () => {
    const core = await newCore();
    core.writeString("\x1b[4$p");
    core.writeString("\x1b[4h\x1b[4$p");
    core.writeString("\x1b[7777$p");
    expect(drain(core)).toEqual(["\x1b[4;2$y", "\x1b[4;1$y", "\x1b[7777;0$y"]);
  });

  it("reports an unrecognized mode as not recognized", async () => {
    const core = await newCore();
    core.writeString("\x1b[?7777$p");
    expect(drain(core)).toEqual(["\x1b[?7777;0$y"]);
  });

  it("answers foreground and background color queries", async () => {
    const core = await newCore();
    core.writeString("\x1b]10;?\x07\x1b]11;?\x1b\\");
    expect(drain(core)).toEqual([
      "\x1b]10;rgb:d4d4/d4d4/d4d4\x07",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
    ]);

    core.writeString("\x1b]10;#123456\x1b\\\x1b]10;?\x1b\\");
    expect(drain(core)).toEqual(["\x1b]10;rgb:1212/3434/5656\x1b\\"]);

    core.writeString("\x1b]110\x1b\\\x1b]10;?\x1b\\");
    expect(drain(core)).toEqual(["\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\"]);

    const themed = await newCore(20, 4, {
      foregroundColor: "#ededed",
      backgroundColor: "#0a0a0a",
    });
    themed.writeString("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
    expect(drain(themed)).toEqual([
      "\x1b]10;rgb:eded/eded/eded\x1b\\",
      "\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\",
    ]);
  });

  it("answers cell and pixel geometry from the authoritative resize", async () => {
    const core = await newCore(20, 4);
    core.resize(20, 4, 200, 80);
    core.writeString("\x1b[14t\x1b[16t\x1b[18t");

    expect(drain(core)).toEqual([
      "\x1b[4;80;200t",
      "\x1b[6;20;10t",
      "\x1b[8;4;20t",
    ]);
  });

  it("queues in-band size reports after resize returns", async () => {
    const core = await newCore(20, 4);
    core.writeString("\x1b[?2048h");
    core.resize(30, 5, 300, 100);

    expect(drain(core)).toEqual(["\x1b[48;4;20;0;0t", "\x1b[48;5;30;100;300t"]);
  });

  it("rejects invalid configured colors", async () => {
    await expect(
      GhosttyCore.load({
        wasmPath: WASM_URL,
        foregroundColor: "white",
      }),
    ).rejects.toThrow(
      "@wterm/ghostty: foregroundColor must be a #RRGGBB color",
    );
  });

  it("keeps replies in the order the queries arrived", async () => {
    const core = await newCore();
    core.writeString("\x1b[c\x1b[6n\x1b[5n");
    expect(drain(core)).toEqual(["\x1b[?62;22c", "\x1b[1;1R", "\x1b[0n"]);
  });

  it("still applies the state changes the readonly handler owned", async () => {
    const core = await newCore();
    core.writeString("hi\x1b[6n");
    core.update?.();
    expect(core.getCell(0, 0).char).toBe("h".codePointAt(0));
    expect(core.getCell(0, 1).char).toBe("i".codePointAt(0));
    expect(core.getCursor().col).toBe(2);
  });
});
