import {
  GHOSTTY_ENGINE_ID,
  GHOSTTY_ENGINE_MANIFEST,
  type GhosttyEngineManifest,
} from "./engine.js";
import { GhosttyCore } from "./ghostty-core.js";
import {
  allocBuffer,
  freeBuffer,
  loadGhosttyWasm,
  type GhosttyWasm,
  type GhosttyWasmSource,
} from "./wasm-bindings.js";

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const FATAL_STATUS_CODE = -1;

const RESTORE_PHASE = Object.freeze({
  ready: 1,
  history: 2,
  finish: 3,
  abandoned: 4,
  failed: 5,
  taken: 6,
} as const);

const RESTORE_STATUS = Object.freeze({
  ok: 0,
  invalidSnapshot: 1,
  continuationLimit: 2,
  outOfMemory: 3,
  invalidContinuation: 4,
  invalidState: 5,
  mutationFailure: 6,
  resizeFailure: 7,
} as const);
const RESTORE_HANDLE_TOKEN = Symbol("GhosttyPassiveRestore");

export type GhosttyRestorePhase = keyof typeof RESTORE_PHASE | "disposed";
export type GhosttyRestoreStatus =
  | keyof typeof RESTORE_STATUS
  | "unknown"
  | "disposed";

export interface GhosttyPassiveRestoreOptions {
  maxContinuationBytes: number;
  effects: "discard";
}

export interface GhosttyRestoreHistoryProgress {
  screen: "primary" | "alternate";
  rows: number;
  remaining: number;
}

export interface GhosttyAdvanceRestoreOptions {
  /** Yield to the browser event loop after every decoded history page. */
  yieldBetweenPages?: boolean;
  /** Aborting explicitly abandons remaining history and keeps READY usable. */
  signal?: AbortSignal;
}

export class GhosttyRestoreError extends Error {
  readonly fatal: boolean;
  readonly status: GhosttyRestoreStatus;

  constructor(
    readonly operation: string,
    readonly statusCode: number,
    reason: string,
    options: { fatal?: boolean; cause?: unknown } = {},
  ) {
    super(`@wterm/ghostty: ${operation} failed: ${reason}`);
    this.name = "GhosttyRestoreError";
    this.fatal = options.fatal ?? false;
    this.status = restoreStatusName(statusCode);
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

function fatalRestoreError(
  operation: string,
  cause: unknown,
): GhosttyRestoreError {
  return new GhosttyRestoreError(
    operation,
    FATAL_STATUS_CODE,
    "the WASM adapter trapped after restore state may have changed; the handle is no longer usable",
    { cause, fatal: true },
  );
}

function restoreStatusName(status: number): GhosttyRestoreStatus {
  for (const [name, value] of Object.entries(RESTORE_STATUS)) {
    if (value === status) return name as keyof typeof RESTORE_STATUS;
  }
  return "unknown";
}

function restoreFailureReason(status: number): string {
  switch (status) {
    case RESTORE_STATUS.invalidSnapshot:
      return "the snapshot is malformed, truncated, or failed integrity checks";
    case RESTORE_STATUS.continuationLimit:
      return "the parser continuation exceeds maxContinuationBytes";
    case RESTORE_STATUS.outOfMemory:
      return "the WASM allocator ran out of memory";
    case RESTORE_STATUS.invalidContinuation:
      return "the parser continuation could not be reconstructed exactly";
    case RESTORE_STATUS.invalidState:
      return "the restore handle is in the wrong phase";
    case RESTORE_STATUS.mutationFailure:
      return "Ghostty rejected a post-snapshot terminal mutation";
    case RESTORE_STATUS.resizeFailure:
      return "Ghostty rejected the post-snapshot resize";
    default:
      return `the WASM adapter returned status ${status}`;
  }
}

/**
 * Incremental owner for one passive Ghostty snapshot restore.
 *
 * The handle owns the restored terminal until `takeCore()` succeeds. History
 * decoding cannot continue after ownership is transferred or explicitly
 * abandoned.
 */
export class GhosttyPassiveRestore {
  private restorePtr: number;
  private disposed = false;
  private fatalError: GhosttyRestoreError | null = null;
  private transferred = false;

  /** @internal Created only by GhosttyRuntime after synchronous READY. */
  constructor(
    private readonly runtime: GhosttyRuntime,
    restorePtr: number,
    token: typeof RESTORE_HANDLE_TOKEN,
  ) {
    if (token !== RESTORE_HANDLE_TOKEN) {
      throw new Error(
        "@wterm/ghostty: passive restore handles must be created by GhosttyRuntime",
      );
    }
    this.restorePtr = restorePtr;
  }

  get phase(): GhosttyRestorePhase {
    if (this.disposed) return "disposed";
    return this._queryPhase("restore phase query");
  }

  get status(): GhosttyRestoreStatus {
    if (this.disposed) return "disposed";
    const status = this._queryStatusCode("restore status query");
    const name = restoreStatusName(status);
    if (name === "unknown") {
      throw this._failClosed(
        "restore status query",
        new Error(`the WASM adapter returned unknown status ${status}`),
      );
    }
    return name;
  }

  decodeNextHistory(): GhosttyRestoreHistoryProgress | null {
    this._assertLive();
    const before = this.phase;
    if (before !== "ready" && before !== "history") {
      throw this._phaseError("history decode", before);
    }
    this._assertStatus(
      this._callWasm("history decode", (ptr) =>
        this.runtime.wasm.exports.restore_next_history(ptr),
      ),
      "history decode",
    );
    const after = this.phase;
    if (after === "finish") return null;
    if (after !== "history") {
      throw this._failClosed(
        "history decode",
        new Error(`the WASM adapter returned ${after} after a successful page`),
      );
    }
    const screen = this._callWasm("history progress query", (ptr) =>
      this.runtime.wasm.exports.restore_progress_screen(ptr),
    );
    if (screen !== 0 && screen !== 1) {
      throw this._failClosed(
        "history progress query",
        new Error(`the WASM adapter returned unknown screen ${screen}`),
      );
    }
    return {
      screen: screen === 0 ? "primary" : "alternate",
      rows:
        this._callWasm("history progress query", (ptr) =>
          this.runtime.wasm.exports.restore_progress_rows(ptr),
        ) >>> 0,
      remaining:
        this._callWasm("history progress query", (ptr) =>
          this.runtime.wasm.exports.restore_progress_remaining(ptr),
        ) >>> 0,
    };
  }

  async advanceToFinish(
    options: GhosttyAdvanceRestoreOptions = {},
  ): Promise<void> {
    this._assertLive();
    const yieldBetweenPages = options.yieldBetweenPages ?? true;
    while (this.phase === "ready" || this.phase === "history") {
      this._abandonIfAborted(options.signal);
      this.decodeNextHistory();
      if (
        yieldBetweenPages &&
        (this.phase === "ready" || this.phase === "history")
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this.phase !== "finish") {
      throw this._phaseError("history completion", this.phase);
    }
  }

  abandonHistory(): void {
    this._assertLive();
    const phase = this.phase;
    if (phase !== "ready" && phase !== "history") {
      throw this._phaseError("history abandonment", phase);
    }
    this._assertStatus(
      this._callWasm("history abandonment", (ptr) =>
        this.runtime.wasm.exports.restore_abandon_history(ptr),
      ),
      "history abandonment",
    );
  }

  writeRaw(data: Uint8Array): void {
    this._assertTailPhase("post-snapshot write");
    this._withTransfer(data, "post-snapshot write", (ptr) => {
      this._assertStatus(
        this._callWasm("post-snapshot write", (restorePtr) =>
          this.runtime.wasm.exports.restore_write(
            restorePtr,
            ptr,
            data.byteLength,
          ),
        ),
        "post-snapshot write",
      );
    });
  }

  resize(cols: number, rows: number, widthPx = 0, heightPx = 0): void {
    this._assertTailPhase("post-snapshot resize");
    for (const [name, value, max] of [
      ["cols", cols, MAX_U16],
      ["rows", rows, MAX_U16],
      ["widthPx", widthPx, MAX_U32],
      ["heightPx", heightPx, MAX_U32],
    ] as const) {
      if (
        !Number.isInteger(value) ||
        value < (name === "cols" || name === "rows" ? 1 : 0) ||
        value > max
      ) {
        throw new Error(
          `@wterm/ghostty: ${name} is outside the supported restore range`,
        );
      }
    }
    this._assertStatus(
      this._callWasm("post-snapshot resize", (ptr) =>
        this.runtime.wasm.exports.restore_resize(
          ptr,
          cols,
          rows,
          widthPx,
          heightPx,
        ),
      ),
      "post-snapshot resize",
    );
  }

  takeCore(): GhosttyCore {
    this._assertLive();
    if (this.transferred) {
      throw new Error("@wterm/ghostty: restored core was already transferred");
    }
    const phase = this.phase;
    if (phase === "taken") {
      throw new Error("@wterm/ghostty: restored core was already transferred");
    }
    if (phase !== "finish" && phase !== "abandoned") {
      throw this._phaseError("restored core transfer", phase);
    }
    const statePtr = this._callWasm("restored core transfer", (ptr) =>
      this.runtime.wasm.exports.restore_take_state(ptr),
    );
    if (statePtr === 0) {
      this._throwCurrentStatus("restored core transfer");
    }
    this.transferred = true;
    return GhosttyCore._fromRestoredState(this.runtime, statePtr);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ptr = this.restorePtr;
    this.restorePtr = 0;
    if (ptr === 0) return;
    try {
      this.runtime.wasm.exports.restore_deinit(ptr);
    } catch {
      // Public disposal is idempotent and best-effort after a WASM trap.
    }
  }

  private _withTransfer(
    data: Uint8Array,
    operationName: string,
    operation: (ptr: number) => void,
  ): void {
    const size = Math.max(1, data.byteLength);
    let ptr: number;
    try {
      ptr = allocBuffer(this.runtime.wasm, size);
    } catch (error) {
      throw this._failClosed(`${operationName} transfer allocation`, error);
    }
    if (ptr === 0) {
      throw new GhosttyRestoreError(
        "restore transfer",
        RESTORE_STATUS.outOfMemory,
        restoreFailureReason(RESTORE_STATUS.outOfMemory),
      );
    }
    let operationFailed = false;
    let operationError: unknown;
    try {
      if (data.byteLength > 0) {
        new Uint8Array(
          this.runtime.wasm.exports.memory.buffer,
          ptr,
          data.byteLength,
        ).set(data);
      }
      operation(ptr);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      freeBuffer(this.runtime.wasm, ptr, size);
    } catch (error) {
      throw this._failClosed(`${operationName} transfer cleanup`, error);
    }
    if (operationFailed) throw operationError;
  }

  private _assertLive(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.disposed) {
      throw new Error("@wterm/ghostty: passive restore handle is disposed");
    }
  }

  private _assertTailPhase(operation: string): void {
    this._assertLive();
    const phase = this.phase;
    if (phase !== "finish" && phase !== "abandoned") {
      throw this._phaseError(operation, phase);
    }
  }

  private _assertStatus(status: number, operation: string): void {
    if (status === RESTORE_STATUS.ok) return;
    if (restoreStatusName(status) === "unknown") {
      throw this._failClosed(
        operation,
        new Error(`the WASM adapter returned unknown status ${status}`),
      );
    }
    throw new GhosttyRestoreError(
      operation,
      status,
      restoreFailureReason(status),
    );
  }

  private _abandonIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const phase = this.phase;
    if (phase === "ready" || phase === "history") this.abandonHistory();
    const error = new Error("@wterm/ghostty: passive restore was aborted");
    error.name = "AbortError";
    throw error;
  }

  private _throwCurrentStatus(operation: string): never {
    const status = this._queryStatusCode(`${operation} status query`);
    if (status === RESTORE_STATUS.ok) {
      throw this._failClosed(
        operation,
        new Error("the WASM adapter returned no State with successful status"),
      );
    }
    if (restoreStatusName(status) === "unknown") {
      throw this._failClosed(
        operation,
        new Error(`the WASM adapter returned unknown status ${status}`),
      );
    }
    throw new GhosttyRestoreError(
      operation,
      status,
      restoreFailureReason(status),
    );
  }

  private _phaseError(operation: string, phase: GhosttyRestorePhase): Error {
    return new Error(
      `@wterm/ghostty: ${operation} is unavailable during ${phase} phase`,
    );
  }

  private _queryPhase(operation: string): keyof typeof RESTORE_PHASE {
    this._assertLive();
    const raw = this._callWasm(operation, (ptr) =>
      this.runtime.wasm.exports.restore_phase(ptr),
    );
    for (const [phase, value] of Object.entries(RESTORE_PHASE)) {
      if (value === raw) return phase as keyof typeof RESTORE_PHASE;
    }
    throw this._failClosed(
      operation,
      new Error(`the WASM adapter returned unknown phase ${raw}`),
    );
  }

  private _queryStatusCode(operation: string): number {
    this._assertLive();
    return this._callWasm(operation, (ptr) =>
      this.runtime.wasm.exports.restore_status(ptr),
    );
  }

  private _callWasm<T>(operation: string, call: (restorePtr: number) => T): T {
    this._assertLive();
    try {
      return call(this.restorePtr);
    } catch (error) {
      throw this._failClosed(operation, error);
    }
  }

  private _failClosed(operation: string, cause: unknown): GhosttyRestoreError {
    if (this.fatalError) return this.fatalError;
    const error = fatalRestoreError(operation, cause);
    const ptr = this.restorePtr;
    this.restorePtr = 0;
    this.fatalError = error;
    if (ptr !== 0) {
      try {
        this.runtime.wasm.exports.restore_deinit(ptr);
      } catch {
        // The pointer was cleared before best-effort native cleanup.
      }
    }
    return error;
  }
}

/** A loaded WASM instance shared by one or more terminal cores and restores. */
export class GhosttyRuntime {
  readonly artifactVerified: boolean;
  readonly engineId = GHOSTTY_ENGINE_ID;
  readonly manifest: GhosttyEngineManifest = GHOSTTY_ENGINE_MANIFEST;

  private constructor(readonly wasm: GhosttyWasm) {
    this.artifactVerified = wasm.artifactVerified;
  }

  static async load(source?: GhosttyWasmSource): Promise<GhosttyRuntime> {
    return new GhosttyRuntime(await loadGhosttyWasm(source));
  }

  beginPassiveRestore(
    snapshot: Uint8Array,
    options: GhosttyPassiveRestoreOptions,
  ): GhosttyPassiveRestore {
    if (options.effects !== "discard") {
      throw new Error(
        '@wterm/ghostty: passive restore requires effects: "discard"',
      );
    }
    if (
      !Number.isInteger(options.maxContinuationBytes) ||
      options.maxContinuationBytes < 0 ||
      options.maxContinuationBytes > MAX_U32
    ) {
      throw new Error(
        "@wterm/ghostty: maxContinuationBytes must be an unsigned 32-bit integer",
      );
    }
    if (snapshot.byteLength > MAX_U32) {
      throw new Error("@wterm/ghostty: snapshot exceeds the WASM size limit");
    }

    const size = Math.max(1, snapshot.byteLength);
    const ptr = allocBuffer(this.wasm, size);
    if (ptr === 0) {
      throw new GhosttyRestoreError(
        "snapshot READY",
        RESTORE_STATUS.outOfMemory,
        restoreFailureReason(RESTORE_STATUS.outOfMemory),
      );
    }
    let restorePtr = 0;
    try {
      if (snapshot.byteLength > 0) {
        new Uint8Array(
          this.wasm.exports.memory.buffer,
          ptr,
          snapshot.byteLength,
        ).set(snapshot);
      }
      restorePtr = this.wasm.exports.restore_begin(
        ptr,
        snapshot.byteLength,
        options.maxContinuationBytes,
      );
    } finally {
      try {
        freeBuffer(this.wasm, ptr, size);
      } catch (error) {
        const cleanupError = fatalRestoreError(
          "snapshot transfer cleanup",
          error,
        );
        if (restorePtr !== 0) {
          const ownedRestorePtr = restorePtr;
          restorePtr = 0;
          try {
            this.wasm.exports.restore_deinit(ownedRestorePtr);
          } catch {
            // Preserve the transfer cleanup failure.
          }
        }
        throw cleanupError;
      }
    }
    if (restorePtr === 0) {
      throw new GhosttyRestoreError(
        "snapshot READY",
        RESTORE_STATUS.outOfMemory,
        restoreFailureReason(RESTORE_STATUS.outOfMemory),
      );
    }

    const restore = new GhosttyPassiveRestore(
      this,
      restorePtr,
      RESTORE_HANDLE_TOKEN,
    );
    try {
      const phase = restore.phase;
      if (phase === "failed") {
        const statusName = restore.status;
        if (statusName === "disposed" || statusName === "unknown") {
          throw fatalRestoreError(
            "snapshot READY status query",
            new Error(`the WASM adapter returned ${statusName} status`),
          );
        }
        const status = RESTORE_STATUS[statusName];
        throw new GhosttyRestoreError(
          "snapshot READY",
          status,
          restoreFailureReason(status),
        );
      }
      if (phase !== "ready") {
        throw fatalRestoreError(
          "snapshot READY",
          new Error(`the WASM adapter entered unexpected ${phase} phase`),
        );
      }
      return restore;
    } catch (error) {
      restore.dispose();
      throw error;
    }
  }
}
