import { useRef, useCallback } from "react";
import type { TerminalHandle } from "./Terminal.js";

export function useTerminal() {
  const ref = useRef<TerminalHandle>(null);

  const write = useCallback((data: string | Uint8Array) => {
    ref.current?.write(data);
  }, []);

  const resize = useCallback(
    (cols: number, rows: number, widthPx?: number, heightPx?: number) => {
      const handle = ref.current;
      if (widthPx === undefined && heightPx === undefined) {
        handle?.resize(cols, rows);
      } else {
        handle?.resize(cols, rows, widthPx, heightPx);
      }
    },
    [],
  );

  const focus = useCallback(() => {
    ref.current?.focus();
  }, []);

  return { ref, write, resize, focus };
}
