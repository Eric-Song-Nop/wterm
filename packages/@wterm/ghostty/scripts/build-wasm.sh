#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZIG_DIR="$SCRIPT_DIR/../zig"
OUT_DIR="$SCRIPT_DIR/../wasm"

# Locate the exact toolchain bound into the engine ID.
ZIG=""
ZIGUP_PATH="$HOME/.local/share/zigup/0.16.0/files/zig"
if [[ -x "$ZIGUP_PATH" ]]; then
  ZIG="$ZIGUP_PATH"
elif command -v zig &>/dev/null && [[ "$(zig version 2>/dev/null)" == "0.16.0" ]]; then
  ZIG="zig"
fi

if [[ -z "$ZIG" ]]; then
  echo "Error: Zig 0.16.0 is required but not found."
  echo ""
  echo "Install it with: zigup 0.16.0"
  echo "or download from https://ziglang.org/download/"
  exit 1
fi

echo "Using Zig: $ZIG ($($ZIG version))"

cd "$ZIG_DIR"
echo "Fetching the exact Ghostty dependency tree..."
"$ZIG" build --fetch=needed
node "$SCRIPT_DIR/generate-engine.mjs" prepare

echo "Building ghostty-vt WASM module..."
"$ZIG" build -Doptimize=ReleaseSmall

mkdir -p "$OUT_DIR"
cp zig-out/bin/ghostty-vt.wasm "$OUT_DIR/"
node "$SCRIPT_DIR/generate-engine.mjs" finalize

echo ""
echo "Built: $OUT_DIR/ghostty-vt.wasm"
ls -lh "$OUT_DIR/ghostty-vt.wasm"
