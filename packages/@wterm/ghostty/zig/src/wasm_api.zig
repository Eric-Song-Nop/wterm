const std = @import("std");
const builtin = @import("builtin");
const vt = @import("ghostty-vt");
const Terminal = vt.Terminal;
const Screen = vt.Screen;
const RenderState = vt.RenderState;
const Style = vt.Style;
const color = vt.color;
const ColorScheme = vt.device_status.ColorScheme;
const StreamAction = vt.StreamAction;
const TerminalHandler = vt.TerminalStream.Handler;
const SizeCallbackPtr = @typeInfo(@FieldType(TerminalHandler.Effects, "size")).optional.child;
const SizeCallbackFn = @typeInfo(SizeCallbackPtr).pointer.child;
const SizeCallbackReturn = @typeInfo(SizeCallbackFn).@"fn".return_type.?;
const TerminalSize = @typeInfo(SizeCallbackReturn).optional.child;
const DeviceAttributesCallbackPtr = @typeInfo(@FieldType(TerminalHandler.Effects, "device_attributes")).optional.child;
const DeviceAttributesCallbackFn = @typeInfo(DeviceAttributesCallbackPtr).pointer.child;
const DeviceAttributes = @typeInfo(DeviceAttributesCallbackFn).@"fn".return_type.?;
const SnapshotDecoder = vt.snapshot.Decoder;

const Allocator = std.mem.Allocator;
const allocator = std.heap.wasm_allocator;
const engine_manifest = @import("engine_manifest.zig");
const BUILD_ID = engine_manifest.build_id;
const TERMINAL_NAME = engine_manifest.terminal_name;
const XTVERSION = engine_manifest.xtversion;
const OUTPUT_ERROR = std.math.maxInt(u32);
const CONTINUATION_MAX_BYTES = 64 * 1024;
const PASTE_MAX_BYTES = 1024 * 1024;
const MUTATION_OK = 0;
const MUTATION_SEMANTIC_FAILURE = 1;
const MUTATION_EFFECT_OVERFLOW = 2;
const MUTATION_RESIZE_FAILURE = 3;
const RENDER_OK = 0;
const RENDER_FAILURE = 1;
const RESTORE_STATUS_OK = 0;
const RESTORE_STATUS_INVALID_SNAPSHOT = 1;
const RESTORE_STATUS_CONTINUATION_LIMIT = 2;
const RESTORE_STATUS_OUT_OF_MEMORY = 3;
const RESTORE_STATUS_INVALID_CONTINUATION = 4;
const RESTORE_STATUS_INVALID_STATE = 5;
const RESTORE_STATUS_MUTATION_FAILURE = 6;
const RESTORE_STATUS_RESIZE_FAILURE = 7;

const RestorePhase = enum(u32) {
    ready = 1,
    history = 2,
    finish = 3,
    abandoned = 4,
    failed = 5,
    taken = 6,
};

var live_state_count: u32 = 0;
var live_restore_count: u32 = 0;
var live_buffer_count: u32 = 0;

fn isUnicodeScalar(value: u32) bool {
    return value <= 0x10FFFF and !(value >= 0xD800 and value <= 0xDFFF);
}

pub const std_options: std.Options = .{
    .logFn = wasmLog,
};

fn wasmLog(
    comptime level: std.log.Level,
    comptime scope: @TypeOf(.EnumLiteral),
    comptime format: []const u8,
    args: anytype,
) void {
    _ = level;
    _ = scope;
    var buf: [2048]u8 = undefined;
    const str = std.fmt.bufPrint(&buf, format, args) catch return;
    JS.log(str.ptr, str.len);
}

const JS = struct {
    extern "env" fn log(ptr: [*]const u8, len: usize) void;
};

// ---------------------------------------------------------------
// Cell layout written into the JS-owned viewport buffer.
// 16 bytes per cell, little-endian.
//
//  offset  size  field
//  ------  ----  -----
//       0     4  codepoint (u32)
//       4     1  fg_r
//       5     1  fg_g
//       6     1  fg_b
//       7     1  bg_r
//       8     1  bg_g
//       9     1  bg_b
//      10     1  flags  (bold=1, faint=2, italic=4, underline=8,
//                        blink=16, inverse=32, invisible=64,
//                        strikethrough=128)
//      11     1  width  (0 = spacer, 1 = normal, 2 = wide)
//      12     1  color_flags (bit 0 = has explicit fg,
//                             bit 1 = has explicit bg)
//      13     1  content_flags (bit 0 = has grapheme data,
//                             bit 1 = has OSC 8 hyperlink)
//      14     2  reserved
// ---------------------------------------------------------------
const CELL_BYTES = 16;

// -- PTY effects ------------------------------------------------
//
// Effects run synchronously inside TerminalStream.nextSlice. The authority
// copies WRITE_PTY payloads into this bounded queue and JS drains it only after
// the write returns, avoiding re-entrancy and blocking I/O in Ghostty callbacks.

const EFFECT_QUEUE_MAX_FRAMES = 256;
const EFFECT_QUEUE_MAX_BYTES = 64 * 1024;

const EffectQueue = struct {
    bytes: [EFFECT_QUEUE_MAX_BYTES]u8 = undefined,
    frame_lens: [EFFECT_QUEUE_MAX_FRAMES]u32 = [_]u32{0} ** EFFECT_QUEUE_MAX_FRAMES,
    byte_head: usize = 0,
    byte_tail: usize = 0,
    byte_count: usize = 0,
    frame_head: u16 = 0,
    frame_tail: u16 = 0,
    frame_count: u16 = 0,
    dropped_frames: u32 = 0,
    dropped_bytes: u32 = 0,

    fn push(self: *EffectQueue, payload: []const u8) void {
        if (payload.len == 0) return;
        if (payload.len > EFFECT_QUEUE_MAX_BYTES - self.byte_count or
            self.frame_count == EFFECT_QUEUE_MAX_FRAMES)
        {
            self.dropped_frames +|= 1;
            self.dropped_bytes +|= std.math.cast(u32, payload.len) orelse std.math.maxInt(u32);
            return;
        }

        const first_len = @min(payload.len, EFFECT_QUEUE_MAX_BYTES - self.byte_tail);
        @memcpy(self.bytes[self.byte_tail .. self.byte_tail + first_len], payload[0..first_len]);
        const second_len = payload.len - first_len;
        if (second_len > 0) @memcpy(self.bytes[0..second_len], payload[first_len..]);

        self.frame_lens[self.frame_tail] = @intCast(payload.len);
        self.frame_tail = (self.frame_tail + 1) % EFFECT_QUEUE_MAX_FRAMES;
        self.frame_count += 1;
        self.byte_tail = (self.byte_tail + payload.len) % EFFECT_QUEUE_MAX_BYTES;
        self.byte_count += payload.len;
    }

    fn peekLen(self: *const EffectQueue) u32 {
        if (self.frame_count == 0) return 0;
        return self.frame_lens[self.frame_head];
    }

    fn pop(self: *EffectQueue, out: []u8) u32 {
        const len = self.peekLen();
        if (len == 0) return 0;
        if (len > out.len) return 0;

        const payload_len: usize = len;
        const first_len = @min(payload_len, EFFECT_QUEUE_MAX_BYTES - self.byte_head);
        @memcpy(out[0..first_len], self.bytes[self.byte_head .. self.byte_head + first_len]);
        const second_len = payload_len - first_len;
        if (second_len > 0) @memcpy(out[first_len..payload_len], self.bytes[0..second_len]);

        self.frame_head = (self.frame_head + 1) % EFFECT_QUEUE_MAX_FRAMES;
        self.frame_count -= 1;
        self.byte_head = (self.byte_head + payload_len) % EFFECT_QUEUE_MAX_BYTES;
        self.byte_count -= payload_len;
        return len;
    }
};

/// Delegates terminal semantics to Ghostty's standard handler. Authority mode
/// installs WRITE_PTY and query effects; replica mode leaves them disabled.
const WTermHandler = struct {
    inner: TerminalHandler,
    effects: *EffectQueue,
    synchronized_output_generation: *u32,
    mouse_config_generation: *u32,

    pub fn init(
        terminal: *Terminal,
        effects: *EffectQueue,
        sync_generation: *u32,
        mouse_config_generation: *u32,
        authority: bool,
    ) WTermHandler {
        var result: WTermHandler = .{
            .inner = .init(terminal),
            .effects = effects,
            .synchronized_output_generation = sync_generation,
            .mouse_config_generation = mouse_config_generation,
        };
        if (authority) {
            result.inner.effects.write_pty = &writePty;
            result.inner.effects.size = &terminalSize;
            result.inner.effects.color_scheme = &colorScheme;
            result.inner.effects.device_attributes = &deviceAttributes;
            result.inner.effects.xtversion = &xtversion;
        }
        result.inner.terminfo_name = TERMINAL_NAME;
        return result;
    }

    fn fromInner(handler: *TerminalHandler) *WTermHandler {
        return @fieldParentPtr("inner", handler);
    }

    fn writePty(handler: *TerminalHandler, bytes: []const u8) void {
        fromInner(handler).effects.push(bytes);
    }

    fn terminalSize(handler: *TerminalHandler) ?TerminalSize {
        const terminal = handler.terminal;
        return .{
            .rows = terminal.rows,
            .columns = terminal.cols,
            .cell_width = if (terminal.cols > 0) terminal.width_px / terminal.cols else 0,
            .cell_height = if (terminal.rows > 0) terminal.height_px / terminal.rows else 0,
        };
    }

    fn colorScheme(handler: *TerminalHandler) ?ColorScheme {
        const background = handler.terminal.colors.background.get() orelse return .dark;
        const luminance = @as(u32, background.r) * 299 +
            @as(u32, background.g) * 587 +
            @as(u32, background.b) * 114;
        return if (luminance >= 128_000) .light else .dark;
    }

    fn deviceAttributes(_: *TerminalHandler) DeviceAttributes {
        return .{};
    }

    fn xtversion(_: *TerminalHandler) []const u8 {
        return XTVERSION;
    }

    pub fn deinit(self: *WTermHandler) void {
        self.inner.deinit();
    }

    pub fn vt(
        self: *WTermHandler,
        comptime action: StreamAction.Tag,
        value: StreamAction.Value(action),
    ) void {
        const mouse_event_before = self.inner.terminal.flags.mouse_event;
        const mouse_format_before = self.inner.terminal.flags.mouse_format;
        switch (action) {
            .set_mode => {
                const was_synchronized = self.inner.terminal.modes.get(.synchronized_output);
                self.inner.vt(action, value);
                if (value.mode == .synchronized_output and
                    !was_synchronized and
                    self.inner.terminal.modes.get(.synchronized_output))
                {
                    self.synchronized_output_generation.* +%= 1;
                }
            },
            .restore_mode => {
                const was_synchronized = self.inner.terminal.modes.get(.synchronized_output);
                self.inner.vt(action, value);
                if (value.mode == .synchronized_output and
                    !was_synchronized and
                    self.inner.terminal.modes.get(.synchronized_output))
                {
                    self.synchronized_output_generation.* +%= 1;
                }
            },
            else => self.inner.vt(action, value),
        }
        if (mouse_event_before != self.inner.terminal.flags.mouse_event or
            mouse_format_before != self.inner.terminal.flags.mouse_format)
        {
            self.mouse_config_generation.* +%= 1;
        }
    }
};

const WTermStream = vt.Stream(WTermHandler);

const State = struct {
    terminal: Terminal,
    stream: WTermStream,
    render: RenderState,
    effects: EffectQueue,
    synchronized_output_generation: u32,
    mouse_config_generation: u32,
    mouse_encoded_config_generation: u32,
    mouse_buttons: u32,
    mouse_last_cell: ?vt.Coordinate,
    output: []u8,
};

const RestoreProgress = struct {
    screen: u32 = 0,
    rows: u32 = 0,
    remaining: u32 = 0,
};

/// Owns every allocation involved in incremental restore until the State is
/// explicitly transferred. The fixed reader and decoder point into this
/// allocation, so the handle must never move.
const RestoreHandle = struct {
    snapshot: ?[]u8,
    reader: std.Io.Reader,
    decoder: SnapshotDecoder,
    state: ?*State,
    phase: RestorePhase,
    status: u32,
    progress: RestoreProgress,
};

fn stateFromPtr(ptr: usize) *State {
    return @ptrFromInt(ptr);
}

fn restoreFromPtr(ptr: usize) *RestoreHandle {
    return @ptrFromInt(ptr);
}

fn deinitState(state: *State) void {
    state.render.deinit(allocator);
    state.stream.deinit();
    state.terminal.deinit(allocator);
    if (state.output.len > 0) allocator.free(state.output);
    allocator.destroy(state);
    live_state_count -= 1;
}

fn releaseRestoreSource(handle: *RestoreHandle) void {
    if (handle.snapshot) |bytes| {
        allocator.free(bytes);
        handle.snapshot = null;
    }
}

fn restoreStatusForError(err: anyerror) u32 {
    return switch (err) {
        error.OutOfMemory => RESTORE_STATUS_OUT_OF_MEMORY,
        error.ContinuationLimitExceeded => RESTORE_STATUS_CONTINUATION_LIMIT,
        error.InvalidContinuation,
        error.ContinuationDisabled,
        error.ContinuationUnavailable,
        => RESTORE_STATUS_INVALID_CONTINUATION,
        else => RESTORE_STATUS_INVALID_SNAPSHOT,
    };
}

fn failRestore(handle: *RestoreHandle, err: anyerror) u32 {
    handle.phase = .failed;
    handle.status = restoreStatusForError(err);
    handle.progress = .{};
    return handle.status;
}

fn replaceOutput(state: *State, bytes: []u8) void {
    if (state.output.len > 0) allocator.free(state.output);
    state.output = bytes;
}

fn finishOutput(state: *State, writer: *std.Io.Writer.Allocating) u32 {
    const bytes = writer.toOwnedSlice() catch return OUTPUT_ERROR;
    const len = std.math.cast(u32, bytes.len) orelse {
        if (bytes.len > 0) allocator.free(bytes);
        return OUTPUT_ERROR;
    };
    replaceOutput(state, bytes);
    return len;
}

fn writeContinuation(
    state: *const State,
    writer: *std.Io.Writer,
) bool {
    state.stream.writeContinuation(writer) catch |err| return switch (err) {
        error.ContinuationDisabled => state.stream.ground(),
        error.ContinuationUnavailable, error.WriteFailed => false,
    };
    return true;
}

fn stateFromDecoded(
    decoded: *vt.snapshot.Decoded,
    continuation_max_bytes: usize,
) !*State {
    const state = try allocator.create(State);
    live_state_count += 1;
    state.terminal = decoded.toOwned();
    state.effects = .{};
    state.synchronized_output_generation = 0;
    state.mouse_config_generation = 0;
    state.mouse_encoded_config_generation = 0;
    state.mouse_buttons = 0;
    state.mouse_last_cell = null;
    state.stream = .init(.{
        .allocator = allocator,
        .continuation_max_bytes = continuation_max_bytes,
        .handler = .init(
            &state.terminal,
            &state.effects,
            &state.synchronized_output_generation,
            &state.mouse_config_generation,
            false,
        ),
    });
    state.render = RenderState.empty;
    state.output = &.{};
    errdefer deinitState(state);

    const continuation: []const u8 = switch (decoded.continuation) {
        .ground => "",
        .bytes => |bytes| bytes,
    };
    if (continuation.len > 0) state.stream.nextSlice(continuation);
    if (state.stream.handler.inner.semantic_failure) {
        return error.InvalidContinuation;
    }

    var replayed: std.Io.Writer.Allocating = .init(allocator);
    defer replayed.deinit();
    if (!writeContinuation(state, &replayed.writer)) {
        return error.InvalidContinuation;
    }
    if (!std.mem.eql(u8, continuation, replayed.written())) {
        return error.InvalidContinuation;
    }
    return state;
}

// -- Lifecycle --------------------------------------------------

export fn init(
    cols: u16,
    rows: u16,
    max_scrollback: u32,
    foreground_rgb: u32,
    background_rgb: u32,
    effects_mode: u32,
) usize {
    const state = allocator.create(State) catch return 0;
    live_state_count += 1;
    state.terminal = Terminal.init((vt.TinyIo.init).io(), allocator, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback_bytes = max_scrollback,
        .max_scrollback_lines = null,
        .colors = .{
            .background = .init(.{
                .r = @truncate(background_rgb >> 16),
                .g = @truncate(background_rgb >> 8),
                .b = @truncate(background_rgb),
            }),
            .foreground = .init(.{
                .r = @truncate(foreground_rgb >> 16),
                .g = @truncate(foreground_rgb >> 8),
                .b = @truncate(foreground_rgb),
            }),
            .cursor = .unset,
            .palette = .default,
        },
        .default_modes = .{ .grapheme_cluster = true },
    }) catch {
        allocator.destroy(state);
        live_state_count -= 1;
        return 0;
    };
    state.effects = .{};
    state.synchronized_output_generation = 0;
    state.mouse_config_generation = 0;
    state.mouse_encoded_config_generation = 0;
    state.mouse_buttons = 0;
    state.mouse_last_cell = null;
    state.stream = .init(.{
        .allocator = allocator,
        .continuation_max_bytes = CONTINUATION_MAX_BYTES,
        .handler = .init(
            &state.terminal,
            &state.effects,
            &state.synchronized_output_generation,
            &state.mouse_config_generation,
            effects_mode != 0,
        ),
    });
    state.render = RenderState.empty;
    state.output = &.{};
    return @intFromPtr(state);
}

export fn deinit(ptr: usize) void {
    deinitState(stateFromPtr(ptr));
}

export fn resize(ptr: usize, cols: u16, rows: u16, width_px: u32, height_px: u32) u32 {
    const state = stateFromPtr(ptr);
    if (cols == 0 or rows == 0) return MUTATION_RESIZE_FAILURE;
    const dropped_before = state.effects.dropped_frames;
    const cell_size: @FieldType(Terminal.Resize, "cell_size_px") = if (width_px > 0 and height_px > 0) .{
        .width = @max(1, width_px / cols),
        .height = @max(1, height_px / rows),
    } else null;
    state.stream.handler.inner.resize(.{
        .cols = cols,
        .rows = rows,
        .cell_size_px = cell_size,
    }) catch return MUTATION_RESIZE_FAILURE;
    state.mouse_last_cell = null;
    if (state.effects.dropped_frames != dropped_before) return MUTATION_EFFECT_OVERFLOW;
    return MUTATION_OK;
}

// -- Data input -------------------------------------------------

export fn write(ptr: usize, data_ptr: [*]const u8, data_len: u32) u32 {
    const state = stateFromPtr(ptr);
    const dropped_before = state.effects.dropped_frames;
    state.stream.nextSlice(data_ptr[0..data_len]);
    if (state.stream.handler.inner.semantic_failure) return MUTATION_SEMANTIC_FAILURE;
    if (state.effects.dropped_frames != dropped_before) return MUTATION_EFFECT_OVERFLOW;
    return MUTATION_OK;
}

// -- Engine and checkpoint data --------------------------------

export fn build_id_ptr() usize {
    return @intFromPtr(BUILD_ID.ptr);
}

export fn build_id_len() u32 {
    return BUILD_ID.len;
}

export fn output_ptr(ptr: usize) usize {
    const output = stateFromPtr(ptr).output;
    return if (output.len == 0) 0 else @intFromPtr(output.ptr);
}

export fn output_len(ptr: usize) u32 {
    return @intCast(stateFromPtr(ptr).output.len);
}

export fn clear_output(ptr: usize) void {
    replaceOutput(stateFromPtr(ptr), &.{});
}

/// Export the exact parser continuation retained by TerminalStream. A zero
/// length is a valid ground continuation; OUTPUT_ERROR reports unavailable
/// tracking or allocation failure.
export fn export_continuation(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    if (!writeContinuation(state, &writer.writer)) return OUTPUT_ERROR;
    return finishOutput(state, &writer);
}

/// Encode one complete Ghostty snapshot synchronously. JS copies the output
/// immediately from output_ptr/output_len before allowing another mutation.
export fn encode_snapshot(ptr: usize) u32 {
    const state = stateFromPtr(ptr);

    var continuation: std.Io.Writer.Allocating = .init(allocator);
    defer continuation.deinit();
    if (!writeContinuation(state, &continuation.writer)) return OUTPUT_ERROR;

    var snapshot: std.Io.Writer.Allocating = .init(allocator);
    defer snapshot.deinit();
    vt.snapshot.encode(
        allocator,
        &snapshot.writer,
        &state.terminal,
        .{ .continuation = if (continuation.written().len == 0)
            .ground
        else
            .{ .bytes = continuation.written() } },
    ) catch return OUTPUT_ERROR;
    return finishOutput(state, &snapshot);
}

// -- Passive snapshot restore ---------------------------------

/// Copy one complete snapshot into a heap-stable incremental decoder and
/// synchronously decode through READY. A nonzero handle is returned even for
/// decode failures so JS can inspect the typed status and dispose uniformly.
export fn restore_begin(
    data_ptr: [*]const u8,
    data_len: u32,
    max_continuation_bytes: u32,
) usize {
    const handle = allocator.create(RestoreHandle) catch return 0;
    live_restore_count += 1;
    handle.* = .{
        .snapshot = null,
        .reader = undefined,
        .decoder = undefined,
        .state = null,
        .phase = .failed,
        .status = RESTORE_STATUS_OUT_OF_MEMORY,
        .progress = .{},
    };

    const snapshot = allocator.dupe(u8, data_ptr[0..data_len]) catch
        return @intFromPtr(handle);
    handle.snapshot = snapshot;
    handle.reader = .fixed(snapshot);
    handle.decoder = .init(&handle.reader);

    var decoded = handle.decoder.ready(
        allocator,
        (vt.TinyIo.init).io(),
        .{ .max_continuation_bytes = max_continuation_bytes },
    ) catch |err| {
        _ = failRestore(handle, err);
        return @intFromPtr(handle);
    };
    defer decoded.deinit(allocator);

    handle.state = stateFromDecoded(
        &decoded,
        max_continuation_bytes,
    ) catch |err| {
        _ = failRestore(handle, err);
        return @intFromPtr(handle);
    };
    handle.phase = .ready;
    handle.status = RESTORE_STATUS_OK;
    return @intFromPtr(handle);
}

export fn restore_phase(ptr: usize) u32 {
    return @intFromEnum(restoreFromPtr(ptr).phase);
}

export fn restore_status(ptr: usize) u32 {
    return restoreFromPtr(ptr).status;
}

/// Consume and apply at most one PAGE record. Manifest and FINISH records may
/// be consumed in the same call, but history work is never batched.
export fn restore_next_history(ptr: usize) u32 {
    const handle = restoreFromPtr(ptr);
    switch (handle.phase) {
        .ready, .history => {},
        else => {
            handle.status = RESTORE_STATUS_INVALID_STATE;
            return handle.status;
        },
    }
    const state = handle.state orelse {
        handle.status = RESTORE_STATUS_INVALID_STATE;
        return handle.status;
    };
    handle.progress = .{};

    const progress = handle.decoder.next(
        allocator,
        &state.terminal,
    ) catch |err| return failRestore(handle, err);
    if (progress) |value| {
        handle.phase = .history;
        handle.status = RESTORE_STATUS_OK;
        handle.progress = .{
            .screen = if (value.key == .primary) 0 else 1,
            .rows = @intCast(value.rows),
            .remaining = value.remaining,
        };
        return RESTORE_STATUS_OK;
    }

    _ = handle.reader.peekByte() catch |err| switch (err) {
        error.EndOfStream => {
            releaseRestoreSource(handle);
            handle.phase = .finish;
            handle.status = RESTORE_STATUS_OK;
            return RESTORE_STATUS_OK;
        },
        else => return failRestore(handle, err),
    };
    return failRestore(handle, error.TrailingData);
}

export fn restore_progress_screen(ptr: usize) u32 {
    return restoreFromPtr(ptr).progress.screen;
}

export fn restore_progress_rows(ptr: usize) u32 {
    return restoreFromPtr(ptr).progress.rows;
}

export fn restore_progress_remaining(ptr: usize) u32 {
    return restoreFromPtr(ptr).progress.remaining;
}

/// Stop consuming history without invalidating the READY terminal. This is an
/// explicit integrity tradeoff and permanently releases the decoder input.
export fn restore_abandon_history(ptr: usize) u32 {
    const handle = restoreFromPtr(ptr);
    switch (handle.phase) {
        .ready, .history => {},
        else => {
            handle.status = RESTORE_STATUS_INVALID_STATE;
            return handle.status;
        },
    }
    releaseRestoreSource(handle);
    handle.phase = .abandoned;
    handle.status = RESTORE_STATUS_OK;
    handle.progress = .{};
    return RESTORE_STATUS_OK;
}

fn restoreTailState(handle: *RestoreHandle) ?*State {
    switch (handle.phase) {
        .finish, .abandoned => {},
        else => {
            handle.status = RESTORE_STATUS_INVALID_STATE;
            return null;
        },
    }
    return handle.state orelse {
        handle.status = RESTORE_STATUS_INVALID_STATE;
        return null;
    };
}

export fn restore_write(
    ptr: usize,
    data_ptr: [*]const u8,
    data_len: u32,
) u32 {
    const handle = restoreFromPtr(ptr);
    const state = restoreTailState(handle) orelse return handle.status;
    state.stream.nextSlice(data_ptr[0..data_len]);
    if (state.stream.handler.inner.semantic_failure) {
        handle.phase = .failed;
        handle.status = RESTORE_STATUS_MUTATION_FAILURE;
        return handle.status;
    }
    handle.status = RESTORE_STATUS_OK;
    return RESTORE_STATUS_OK;
}

export fn restore_resize(
    ptr: usize,
    cols: u16,
    rows: u16,
    width_px: u32,
    height_px: u32,
) u32 {
    const handle = restoreFromPtr(ptr);
    const state = restoreTailState(handle) orelse return handle.status;
    if (cols == 0 or rows == 0) {
        handle.status = RESTORE_STATUS_RESIZE_FAILURE;
        return handle.status;
    }
    const cell_size: @FieldType(Terminal.Resize, "cell_size_px") = if (width_px > 0 and height_px > 0) .{
        .width = @max(1, width_px / cols),
        .height = @max(1, height_px / rows),
    } else null;
    state.stream.handler.inner.resize(.{
        .cols = cols,
        .rows = rows,
        .cell_size_px = cell_size,
    }) catch {
        handle.status = RESTORE_STATUS_RESIZE_FAILURE;
        return handle.status;
    };
    state.mouse_last_cell = null;
    handle.status = RESTORE_STATUS_OK;
    return RESTORE_STATUS_OK;
}

/// Transfer the restored State exactly once. Only validated FINISH or an
/// explicit history abandonment permits ownership transfer.
export fn restore_take_state(ptr: usize) usize {
    const handle = restoreFromPtr(ptr);
    switch (handle.phase) {
        .finish, .abandoned => {},
        else => {
            handle.status = RESTORE_STATUS_INVALID_STATE;
            return 0;
        },
    }
    const state = handle.state orelse {
        handle.status = RESTORE_STATUS_INVALID_STATE;
        return 0;
    };
    handle.state = null;
    handle.phase = .taken;
    handle.status = RESTORE_STATUS_OK;
    releaseRestoreSource(handle);
    return @intFromPtr(state);
}

export fn restore_deinit(ptr: usize) void {
    const handle = restoreFromPtr(ptr);
    if (handle.state) |state| deinitState(state);
    releaseRestoreSource(handle);
    allocator.destroy(handle);
    live_restore_count -= 1;
}

// -- Semantic input encoding -----------------------------------

export fn encode_key(
    ptr: usize,
    key_ptr: [*]const u8,
    key_len: u32,
    text_ptr: [*]const u8,
    text_len: u32,
    modifiers: u16,
    consumed_modifiers: u16,
    action_raw: u32,
    composing: u32,
    unshifted_codepoint: u32,
) u32 {
    const state = stateFromPtr(ptr);
    if (action_raw > @intFromEnum(vt.input.KeyAction.repeat) or
        (unshifted_codepoint != 0 and !isUnicodeScalar(unshifted_codepoint)))
    {
        return OUTPUT_ERROR;
    }

    const key = std.meta.stringToEnum(
        vt.input.Key,
        key_ptr[0..key_len],
    ) orelse .unidentified;
    const unshifted: u21 = if (unshifted_codepoint > 0)
        @intCast(unshifted_codepoint)
    else
        key.codepoint() orelse 0;
    const event: vt.input.KeyEvent = .{
        .action = @enumFromInt(action_raw),
        .key = key,
        .mods = @bitCast(modifiers),
        .consumed_mods = @bitCast(consumed_modifiers),
        .composing = composing != 0,
        .utf8 = text_ptr[0..text_len],
        .unshifted_codepoint = unshifted,
    };

    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    vt.input.encodeKey(
        &writer.writer,
        event,
        .fromTerminal(&state.terminal),
    ) catch return OUTPUT_ERROR;
    return finishOutput(state, &writer);
}

export fn encode_paste(
    ptr: usize,
    data_ptr: [*]const u8,
    data_len: u32,
) u32 {
    if (data_len > PASTE_MAX_BYTES) return OUTPUT_ERROR;
    const state = stateFromPtr(ptr);
    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    vt.input.encodePasteWriter(
        &writer.writer,
        data_ptr[0..data_len],
        .fromTerminal(&state.terminal),
    ) catch return OUTPUT_ERROR;
    return finishOutput(state, &writer);
}

export fn encode_focus(ptr: usize, gained: u32) u32 {
    const state = stateFromPtr(ptr);
    if (gained == 0) {
        state.mouse_buttons = 0;
        state.mouse_last_cell = null;
    }
    if (!state.terminal.modes.get(.focus_event)) {
        replaceOutput(state, &.{});
        return 0;
    }

    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    vt.input.encodeFocus(
        &writer.writer,
        if (gained != 0) .gained else .lost,
    ) catch return OUTPUT_ERROR;
    return finishOutput(state, &writer);
}

export fn encode_mouse(
    ptr: usize,
    action_raw: u32,
    button_raw: u32,
    buttons: u32,
    modifiers: u16,
    x: f32,
    y: f32,
) u32 {
    if (action_raw > @intFromEnum(vt.input.MouseAction.motion) or
        button_raw > @intFromEnum(vt.input.MouseButton.eleven) or
        buttons > 0b1_1111 or
        !std.math.isFinite(x) or
        !std.math.isFinite(y))
    {
        return OUTPUT_ERROR;
    }

    const state = stateFromPtr(ptr);
    const terminal = &state.terminal;
    if (terminal.cols == 0 or terminal.rows == 0 or
        terminal.width_px == 0 or terminal.height_px == 0)
    {
        return OUTPUT_ERROR;
    }
    if (state.mouse_encoded_config_generation != state.mouse_config_generation) {
        state.mouse_last_cell = null;
        state.mouse_encoded_config_generation = state.mouse_config_generation;
    }
    state.mouse_buttons = buttons;

    var options: vt.input.MouseEncodeOptions = .fromTerminal(terminal, .{
        .screen = .{
            .width = terminal.width_px,
            .height = terminal.height_px,
        },
        .cell = .{
            .width = @max(1, terminal.width_px / terminal.cols),
            .height = @max(1, terminal.height_px / terminal.rows),
        },
        .padding = .{},
    });
    options.any_button_pressed = state.mouse_buttons != 0;
    options.last_cell = &state.mouse_last_cell;

    var writer: std.Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    vt.input.encodeMouse(&writer.writer, .{
        .action = @enumFromInt(action_raw),
        .button = if (button_raw == 0) null else @enumFromInt(button_raw),
        .mods = @bitCast(modifiers),
        .pos = .{ .x = x, .y = y },
    }, options) catch return OUTPUT_ERROR;
    return finishOutput(state, &writer);
}

// -- Render state -----------------------------------------------

export fn update(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    state.render.update(allocator, &state.terminal) catch return RENDER_FAILURE;
    return RENDER_OK;
}

fn packFlags(style: Style) u8 {
    var f: u8 = 0;
    if (style.flags.bold) f |= 0x01;
    if (style.flags.faint) f |= 0x02;
    if (style.flags.italic) f |= 0x04;
    if (style.flags.underline != .none) f |= 0x08;
    if (style.flags.blink) f |= 0x10;
    if (style.flags.inverse) f |= 0x20;
    if (style.flags.invisible) f |= 0x40;
    if (style.flags.strikethrough) f |= 0x80;
    return f;
}

fn resolveRgb(c: Style.Color, palette: *const color.Palette) color.RGB {
    return switch (c) {
        .none => .{},
        .palette => |idx| palette[idx],
        .rgb => |rgb| rgb,
    };
}

fn cellWidth(cell: vt.Cell) u8 {
    return switch (cell.wide) {
        .narrow => 1,
        .wide => 2,
        // Width 0 means "continuation of the wide cell to my left", which the
        // renderer skips. Only the tail is that. A spacer head is the blank
        // left at the right margin when a wide glyph wrapped to the next row:
        // it follows a narrow cell and owns its column.
        .spacer_tail => 0,
        .spacer_head => 1,
    };
}

/// Encode one cell into the 16-byte layout described above.
///
/// This mirrors the packing get_viewport does inline. The two are kept
/// separate because get_viewport reads RenderState, which only covers the
/// active area, while scrollback reads page memory directly. Changes to the
/// cell contract belong in both.
fn encodeCell(
    raw: *const vt.Cell,
    style: Style,
    palette: *const color.Palette,
    out: *[CELL_BYTES]u8,
) void {
    const cp: u32 = switch (raw.content_tag) {
        .codepoint, .codepoint_grapheme => raw.codepoint(),
        else => 0,
    };

    const has_fg = style.fg_color != .none;
    const has_bg_style = style.bg_color != .none;
    const has_bg_cell = raw.content_tag == .bg_color_palette or raw.content_tag == .bg_color_rgb;
    const has_bg = has_bg_style or has_bg_cell;

    const fg = if (has_fg) resolveRgb(style.fg_color, palette) else color.RGB{};
    const bg = if (has_bg_cell) switch (raw.content_tag) {
        .bg_color_palette => palette[raw.content.color_palette.data],
        .bg_color_rgb => blk: {
            const c = raw.content.color_rgb;
            break :blk color.RGB{ .r = c.r, .g = c.g, .b = c.b };
        },
        else => unreachable,
    } else if (has_bg_style) resolveRgb(style.bg_color, palette) else color.RGB{};

    std.mem.writeInt(u32, out[0..4], cp, .little);
    out[4] = fg.r;
    out[5] = fg.g;
    out[6] = fg.b;
    out[7] = bg.r;
    out[8] = bg.g;
    out[9] = bg.b;
    out[10] = packFlags(style);
    out[11] = cellWidth(raw.*);
    out[12] = (if (has_fg) @as(u8, 1) else 0) | (if (has_bg) @as(u8, 2) else 0);
    out[13] = (if (raw.content_tag == .codepoint_grapheme) @as(u8, 1) else 0) |
        (if (raw.hyperlink) @as(u8, 2) else 0);
    out[14] = 0;
    out[15] = 0;
}

/// Write the entire viewport into a JS-provided flat buffer.
/// Returns the number of cells written (rows * cols).
export fn get_viewport(ptr: usize, buf_ptr: [*]u8, max_cells: u32) u32 {
    const state = stateFromPtr(ptr);
    const rs = &state.render;
    const rows = rs.rows;
    const cols = rs.cols;
    const required_cells = @as(u32, rows) * @as(u32, cols);
    if (required_cells > max_cells) return OUTPUT_ERROR;
    const palette = &rs.colors.palette;

    const row_cells_slice = rs.row_data.items(.cells);

    var offset: usize = 0;
    for (0..rows) |y| {
        if (y >= row_cells_slice.len) {
            // Pad remaining rows with blank cells
            const remaining = (@as(usize, rows) - y) * @as(usize, cols) * CELL_BYTES;
            @memset(buf_ptr[offset .. offset + remaining], 0);
            break;
        }
        const cells_mal = row_cells_slice[y];
        const raw_cells = cells_mal.items(.raw);
        const style_cells = cells_mal.items(.style);

        for (0..cols) |x| {
            if (x >= raw_cells.len) {
                @memset(buf_ptr[offset .. offset + CELL_BYTES], 0);
                offset += CELL_BYTES;
                continue;
            }
            const raw = raw_cells[x];
            // RenderState.Cell.style is undefined unless the raw cell carries a
            // non-default style_id. The style array is reused across render
            // passes, so reading it unconditionally resurfaces the style of
            // whatever occupied this cell before, including a different screen.
            const style: Style = if (raw.style_id != 0) style_cells[x] else .{};

            const cp: u32 = switch (raw.content_tag) {
                .codepoint, .codepoint_grapheme => raw.codepoint(),
                else => 0,
            };

            const has_fg = style.fg_color != .none;
            const has_bg_style = style.bg_color != .none;
            const has_bg_cell = raw.content_tag == .bg_color_palette or raw.content_tag == .bg_color_rgb;
            const has_bg = has_bg_style or has_bg_cell;

            const fg = if (has_fg) resolveRgb(style.fg_color, palette) else color.RGB{};
            const bg = if (has_bg_cell) switch (raw.content_tag) {
                .bg_color_palette => palette[raw.content.color_palette.data],
                .bg_color_rgb => blk: {
                    const c = raw.content.color_rgb;
                    break :blk color.RGB{ .r = c.r, .g = c.g, .b = c.b };
                },
                else => unreachable,
            } else if (has_bg_style) resolveRgb(style.bg_color, palette) else color.RGB{};

            const flags = packFlags(style);
            const width = cellWidth(raw);
            const color_flags: u8 = (if (has_fg) @as(u8, 1) else 0) | (if (has_bg) @as(u8, 2) else 0);

            std.mem.writeInt(u32, buf_ptr[offset..][0..4], cp, .little);
            buf_ptr[offset + 4] = fg.r;
            buf_ptr[offset + 5] = fg.g;
            buf_ptr[offset + 6] = fg.b;
            buf_ptr[offset + 7] = bg.r;
            buf_ptr[offset + 8] = bg.g;
            buf_ptr[offset + 9] = bg.b;
            buf_ptr[offset + 10] = flags;
            buf_ptr[offset + 11] = width;
            buf_ptr[offset + 12] = color_flags;
            buf_ptr[offset + 13] =
                (if (raw.content_tag == .codepoint_grapheme) @as(u8, 1) else 0) |
                (if (raw.hyperlink) @as(u8, 2) else 0);
            buf_ptr[offset + 14] = 0;
            buf_ptr[offset + 15] = 0;
            offset += CELL_BYTES;
        }
    }

    return required_cells;
}

fn encodeGrapheme(
    base: u21,
    extras: []const u21,
    buf_addr: usize,
    buf_len: u32,
) u32 {
    if (extras.len == 0) return 0;
    var required: usize = 0;
    for (0..extras.len + 1) |i| {
        const cp = if (i == 0) base else extras[i - 1];
        required += std.unicode.utf8CodepointSequenceLength(cp) catch return 0;
    }
    if (required > buf_len or buf_addr == 0) return @intCast(required);

    const buf_ptr: [*]u8 = @ptrFromInt(buf_addr);
    var offset: usize = 0;
    for (0..extras.len + 1) |i| {
        const cp = if (i == 0) base else extras[i - 1];
        var utf8: [4]u8 = undefined;
        const len = std.unicode.utf8Encode(cp, &utf8) catch return 0;
        @memcpy(buf_ptr[offset .. offset + len], utf8[0..len]);
        offset += len;
    }
    return @intCast(offset);
}

export fn get_viewport_grapheme(
    ptr: usize,
    row: u32,
    col: u32,
    buf_ptr: usize,
    buf_len: u32,
) u32 {
    const state = stateFromPtr(ptr);
    const rs = &state.render;
    if (row >= rs.rows or col >= rs.cols) return 0;
    const row_cells = rs.row_data.items(.cells);
    if (row >= row_cells.len) return 0;
    const cells = row_cells[row];
    const raw = cells.items(.raw);
    if (col >= raw.len or raw[col].content_tag != .codepoint_grapheme) return 0;
    return encodeGrapheme(
        raw[col].codepoint(),
        cells.items(.grapheme)[col],
        buf_ptr,
        buf_len,
    );
}

fn encodeHyperlink(
    pin: vt.Pin,
    col: u32,
    buf_addr: usize,
    buf_len: u32,
) u32 {
    const cells = pin.cells(.all);
    if (col >= cells.len or !cells[col].hyperlink) return 0;
    const page = pin.node.page();
    const link_id = page.lookupHyperlink(&cells[col]) orelse return 0;
    const entry = page.hyperlink_set.get(page.memory, link_id);
    const uri = entry.uri.slice(page.memory);
    const explicit_id: []const u8 = switch (entry.id) {
        .explicit => |value| value.slice(page.memory),
        .implicit => "",
    };
    var implicit_buf: [20]u8 = undefined;
    const implicit_id: []const u8 = switch (entry.id) {
        .explicit => "",
        .implicit => |value| std.fmt.bufPrint(&implicit_buf, "{d}", .{value}) catch return 0,
    };
    const required = uri.len + explicit_id.len + implicit_id.len + 2;
    if (required > buf_len or buf_addr == 0) return @intCast(required);

    const out: [*]u8 = @ptrFromInt(buf_addr);
    var offset: usize = 0;
    @memcpy(out[offset .. offset + uri.len], uri);
    offset += uri.len;
    out[offset] = 0;
    offset += 1;
    @memcpy(out[offset .. offset + explicit_id.len], explicit_id);
    offset += explicit_id.len;
    out[offset] = 0;
    offset += 1;
    @memcpy(out[offset .. offset + implicit_id.len], implicit_id);
    return @intCast(required);
}

export fn get_viewport_hyperlink(
    ptr: usize,
    row: u32,
    col: u32,
    buf_ptr: usize,
    buf_len: u32,
) u32 {
    const state = stateFromPtr(ptr);
    const rs = &state.render;
    if (row >= rs.rows or col >= rs.cols) return 0;
    const pins = rs.row_data.items(.pin);
    if (row >= pins.len) return 0;
    return encodeHyperlink(pins[row], col, buf_ptr, buf_len);
}

// -- Dirty tracking ---------------------------------------------

export fn is_dirty(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return switch (state.render.dirty) {
        .false => 0,
        .partial => 1,
        .full => 2,
    };
}

export fn is_dirty_row(ptr: usize, row: u16) u32 {
    const state = stateFromPtr(ptr);
    const row_dirty = state.render.row_data.items(.dirty);
    if (row >= row_dirty.len) return 0;
    return if (row_dirty[row]) 1 else 0;
}

export fn clear_dirty(ptr: usize) void {
    const state = stateFromPtr(ptr);
    state.render.dirty = .false;
    const row_dirty = state.render.row_data.items(.dirty);
    for (row_dirty) |*d| d.* = false;
}

// -- Cursor -----------------------------------------------------

export fn get_cursor_row(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return state.render.cursor.active.y;
}

export fn get_cursor_col(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return state.render.cursor.active.x;
}

export fn get_cursor_visible(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.render.cursor.visible) 1 else 0;
}

// -- Modes ------------------------------------------------------

export fn cursor_keys_app(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.modes.get(.cursor_keys)) 1 else 0;
}

export fn bracketed_paste(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.modes.get(.bracketed_paste)) 1 else 0;
}

export fn using_alt_screen(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.screens.active_key != .primary) 1 else 0;
}

export fn mouse_tracking(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return switch (state.terminal.flags.mouse_event) {
        .x10 => 9,
        .normal => 1000,
        .button => 1002,
        .any => 1003,
        else => 0,
    };
}

export fn mouse_sgr(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.flags.mouse_format == .sgr) 1 else 0;
}

export fn focus_events(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.modes.get(.focus_event)) 1 else 0;
}

export fn synchronized_output(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return if (state.terminal.modes.get(.synchronized_output)) 1 else 0;
}

export fn synchronized_output_generation(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return state.synchronized_output_generation;
}

// -- Grid dimensions --------------------------------------------

export fn get_cols(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return state.render.cols;
}

export fn get_rows(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    return state.render.rows;
}

export fn terminal_cols(ptr: usize) u32 {
    return stateFromPtr(ptr).terminal.cols;
}

export fn terminal_rows(ptr: usize) u32 {
    return stateFromPtr(ptr).terminal.rows;
}

// -- Scrollback -------------------------------------------------

export fn get_scrollback_count(ptr: usize) u32 {
    const state = stateFromPtr(ptr);
    const screen: *Screen = state.terminal.screens.active;
    const total = screen.pages.total_rows;
    if (total <= state.terminal.rows) return 0;
    return @intCast(total - state.terminal.rows);
}

/// Write one scrollback row into a JS-provided buffer, using the same cell
/// layout as get_viewport.
///
/// Offset 0 is the row directly above the active area (the newest retained
/// row) and offset get_scrollback_count() - 1 is the oldest, matching the
/// order the renderer inserts rows in and the built-in core's readback.
///
/// Returns the number of cells written, which is the row's grid width capped
/// at max_cols, or 0 when the offset is out of range. This reads the page list
/// rather than RenderState, which only covers the active area.
export fn get_scrollback_line(ptr: usize, offset: u32, buf_ptr: [*]u8, max_cols: u32) u32 {
    const state = stateFromPtr(ptr);
    const screen: *Screen = state.terminal.screens.active;

    // Walking up from the active top means small offsets, the ones the
    // renderer asks for while scrolling, traverse the fewest pages.
    // usize is 32-bit on wasm32, so offset is caller-supplied input that can
    // overflow this increment and wrap to the newest row.
    const rows_up = std.math.add(usize, offset, 1) catch return 0;
    const pin = screen.pages.getTopLeft(.active).up(rows_up) orelse return 0;

    const palette = &state.terminal.colors.palette.current;
    const cells = pin.cells(.all);
    const count = @min(cells.len, max_cols);

    var buf_offset: usize = 0;
    for (cells[0..count]) |*raw| {
        // Pin.style applies the same style_id gating get_viewport relies on.
        const style = pin.style(raw);
        encodeCell(raw, style, palette, buf_ptr[buf_offset..][0..CELL_BYTES]);
        buf_offset += CELL_BYTES;
    }

    return @intCast(count);
}

export fn get_scrollback_grapheme(
    ptr: usize,
    offset: u32,
    col: u32,
    buf_ptr: usize,
    buf_len: u32,
) u32 {
    const state = stateFromPtr(ptr);
    const screen: *Screen = state.terminal.screens.active;
    const rows_up = std.math.add(usize, offset, 1) catch return 0;
    const pin = screen.pages.getTopLeft(.active).up(rows_up) orelse return 0;
    const cells = pin.cells(.all);
    if (col >= cells.len or cells[col].content_tag != .codepoint_grapheme) return 0;
    return encodeGrapheme(
        cells[col].codepoint(),
        pin.grapheme(&cells[col]) orelse return 0,
        buf_ptr,
        buf_len,
    );
}

export fn get_scrollback_hyperlink(
    ptr: usize,
    offset: u32,
    col: u32,
    buf_ptr: usize,
    buf_len: u32,
) u32 {
    const state = stateFromPtr(ptr);
    const screen: *Screen = state.terminal.screens.active;
    const rows_up = std.math.add(usize, offset, 1) catch return 0;
    const pin = screen.pages.getTopLeft(.active).up(rows_up) orelse return 0;
    return encodeHyperlink(pin, col, buf_ptr, buf_len);
}

// -- PTY effects ------------------------------------------------

export fn next_effect_len(ptr: usize) u32 {
    return stateFromPtr(ptr).effects.peekLen();
}

export fn read_effect(ptr: usize, buf_ptr: [*]u8, buf_len: u32) u32 {
    return stateFromPtr(ptr).effects.pop(buf_ptr[0..buf_len]);
}

export fn dropped_effect_frames(ptr: usize) u32 {
    return stateFromPtr(ptr).effects.dropped_frames;
}

export fn dropped_effect_bytes(ptr: usize) u32 {
    return stateFromPtr(ptr).effects.dropped_bytes;
}

/// Compatibility alias for TerminalCore.getResponse().
export fn read_response(ptr: usize, buf_ptr: [*]u8, buf_len: u32) u32 {
    return read_effect(ptr, buf_ptr, buf_len);
}

// -- Memory management ------------------------------------------

export fn alloc_buffer(len: u32) usize {
    const buf = allocator.alloc(u8, len) catch return 0;
    live_buffer_count += 1;
    return @intFromPtr(buf.ptr);
}

export fn free_buffer(buf_ptr: usize, len: u32) void {
    const slice: [*]u8 = @ptrFromInt(buf_ptr);
    allocator.free(slice[0..len]);
    live_buffer_count -= 1;
}

/// Observable ownership counters used by lifecycle stress tests and runtime
/// diagnostics. They count live adapter objects, not allocator internals.
export fn live_restore_handles() u32 {
    return live_restore_count;
}

export fn live_terminal_states() u32 {
    return live_state_count;
}

export fn live_bridge_buffers() u32 {
    return live_buffer_count;
}
