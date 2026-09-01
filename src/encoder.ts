// Default SF3Encoder: wasm-media-encoders (libvorbis WASM) in a pool of
// Web Workers / worker_threads. One encoder instance per worker so concurrent
// encodes use multiple CPU cores without sharing mutable WASM state.
//
// Workers:
//   Deno -> globalThis.Worker (module worker)
//   Node -> node:worker_threads
// Same worker script (_wasm-encoder-worker.ts / .js) handles both via a small
// isNode branch.
//
// DOM globals (navigator, Worker, ErrorEvent, etc.) are accessed via globalThis
// so @deno/dnt's Node-oriented typecheck does not require DOM lib types.
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import type { SF3Encoder } from "@marmooo/soundfont";

export interface DefaultEncoderOptions {
  // Vorbis VBR quality passed to wasm-media-encoders [-1, 10].
  // Defaults to 4. Higher = larger / better; lower = smaller / worse.
  // (Previous mediabunny path used bitsPerHz; this is a different scale.)
  quality?: number;
  // How many worker threads to keep. Defaults to navigator.hardwareConcurrency
  // (or 4). Each concurrent encode occupies one worker; excess encodes queue.
  // Prefer matching write()'s concurrency.
  poolSize?: number;
}

// Minimal shape shared by Deno's Worker and node:worker_threads.Worker.
type WorkerLike = {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
  // Deno
  onmessage?: ((ev: { data: unknown }) => void) | null;
  onerror?: ((err: { message?: string }) => void) | null;
  // Node
  on?(event: "message", listener: (data: unknown) => void): unknown;
  on?(event: "error", listener: (err: Error) => void): unknown;
};

type DenoGlobal = {
  Deno?: { execPath?: unknown };
  navigator?: { hardwareConcurrency?: number };
  Worker?: new (
    scriptURL: string | URL,
    options?: { type?: string },
  ) => WorkerLike;
};

function isDenoRuntime(): boolean {
  const d = (globalThis as DenoGlobal).Deno;
  return typeof d !== "undefined" && typeof d.execPath === "function";
}

function resolveWorkerPath(): string {
  const self = import.meta.url;
  const workerRel = self.endsWith(".ts")
    ? "./_wasm-encoder-worker.ts"
    : "./_wasm-encoder-worker.js";
  const workerUrl = new URL(workerRel, self);
  if (isDenoRuntime()) return workerUrl.href;
  return fileURLToPath(workerUrl);
}

function defaultPoolSize(): number {
  const nav = (globalThis as DenoGlobal).navigator;
  return typeof nav !== "undefined" && nav.hardwareConcurrency
    ? nav.hardwareConcurrency
    : 4;
}

type Pending = {
  resolve: (v: Uint8Array) => void;
  reject: (e: Error) => void;
};

type Slot = {
  worker: WorkerLike;
  busy: boolean;
};

type WorkerReadyMsg = { ready: true };
type WorkerOkMsg = { id: number; ogg: ArrayBuffer };
type WorkerErrMsg = { id: number; error: string };
type WorkerMsg = WorkerReadyMsg | WorkerOkMsg | WorkerErrMsg;

// Creates an SF3Encoder backed by a pool of wasm-media-encoders workers.
// Call `dispose()` when finished to terminate workers; otherwise they exit
// with the parent process.
export function createDefaultEncoder(
  options: DefaultEncoderOptions = {},
): SF3Encoder & { dispose?: () => void } {
  const quality = options.quality ?? 4;
  const poolSize = Math.max(1, options.poolSize ?? defaultPoolSize());
  const workerPath = resolveWorkerPath();
  const deno = isDenoRuntime();

  const slots: Slot[] = [];
  const waiters: Array<(s: Slot) => void> = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;
  let readyCount = 0;
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((r) => {
    readyResolve = r;
  });

  function release(slot: Slot) {
    slot.busy = false;
    const w = waiters.shift();
    if (w) {
      slot.busy = true;
      w(slot);
    }
  }

  function acquire(): Promise<Slot> {
    const free = slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  function onWorkerMessage(slot: Slot, msg: unknown) {
    const m = msg as WorkerMsg;
    if ("ready" in m && m.ready) {
      readyCount++;
      if (readyCount >= poolSize) readyResolve?.();
      release(slot);
      return;
    }

    if (!("id" in m)) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    release(slot);
    if ("error" in m) p.reject(new Error(String(m.error)));
    else p.resolve(new Uint8Array(m.ogg));
  }

  function spawnOne(): Slot {
    let worker: WorkerLike;
    if (deno) {
      // Deno's module Worker. Read from globalThis so dnt typecheck (Node libs)
      // does not require the DOM Worker constructor.
      const DenoWorker = (globalThis as DenoGlobal).Worker;
      if (!DenoWorker) {
        throw new Error(
          "globalThis.Worker is not available in this Deno runtime",
        );
      }
      worker = new DenoWorker(workerPath, { type: "module" });
    } else {
      // Node (npm build via dnt)
      worker = new NodeWorker(workerPath) as unknown as WorkerLike;
    }

    const slot: Slot = { worker, busy: true }; // busy until ready

    if (deno) {
      worker.onmessage = (ev: { data: unknown }) =>
        onWorkerMessage(slot, ev.data);
      worker.onerror = (err: { message?: string }) => {
        console.error("encoder worker error:", err.message ?? String(err));
        release(slot);
      };
    } else {
      worker.on!("message", (data: unknown) => onWorkerMessage(slot, data));
      worker.on!("error", (err: Error) => {
        console.error("encoder worker error:", err.message);
        release(slot);
      });
    }

    return slot;
  }

  for (let i = 0; i < poolSize; i++) {
    slots.push(spawnOne());
  }

  const encode: SF3Encoder & { dispose?: () => void } = async (
    pcm,
    sampleRate,
  ) => {
    if (disposed) throw new Error("encoder disposed");
    await readyPromise;

    const slot = await acquire();
    const id = nextId++;
    const copy = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength,
    );
    // Ensure transfer list only contains ArrayBuffer (not SharedArrayBuffer).
    const transferable: ArrayBuffer = copy instanceof ArrayBuffer
      ? copy
      : (() => {
        const ab = new ArrayBuffer(pcm.byteLength);
        new Uint8Array(ab).set(
          new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        );
        return ab;
      })();

    return new Promise<Uint8Array>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        const payload = { id, pcm: transferable, sampleRate, quality };
        slot.worker.postMessage(payload, [transferable]);
      } catch (e) {
        pending.delete(id);
        release(slot);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };

  encode.dispose = () => {
    disposed = true;
    for (const s of slots) {
      try {
        s.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    slots.length = 0;
    for (const [, p] of pending) p.reject(new Error("encoder disposed"));
    pending.clear();
  };

  return encode;
}
