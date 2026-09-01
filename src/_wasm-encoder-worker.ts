// Vorbis encode worker for @marmooo/sf2-to-sf3 (wasm-media-encoders).
//
// Runs under Deno (module Worker) and Node (worker_threads) with the same
// script. One long-lived encoder instance per worker.
//
// Protocol:
//   req: { id, pcm: ArrayBuffer /* s16le mono */, sampleRate, quality }
//   res: { id, ogg: ArrayBuffer } | { id, error: string }
//   boot: { ready: true }
// pcm / ogg are transferred when possible.
//
// No top-level await: required so dnt can emit CommonJS/UMD for the npm
// package. Encoder init + message wiring runs inside an async boot().

import { createOggEncoder, type WasmMediaEncoder } from "wasm-media-encoders";

type WorkerGlobal = typeof globalThis & {
  Deno?: unknown;
  postMessage?: (msg: unknown, transfer?: ArrayBuffer[]) => void;
  onmessage?: ((ev: MessageEvent) => void) | null;
};

const g = globalThis as WorkerGlobal;
const isNode = typeof g.Deno === "undefined" &&
  typeof process !== "undefined" &&
  Boolean(process.versions?.node);

function toFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Always produce a real ArrayBuffer suitable for the transfer list. */
function toTransferableArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const sliced = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  );
  if (sliced instanceof ArrayBuffer) return sliced;
  const copy = new ArrayBuffer(u8.byteLength);
  new Uint8Array(copy).set(u8);
  return copy;
}

function handle(
  encoder: WasmMediaEncoder<"audio/ogg">,
  data: { id: number; pcm: ArrayBuffer; sampleRate: number; quality: number },
): { id: number; ogg: ArrayBuffer } | { id: number; error: string } {
  try {
    encoder.configure({
      sampleRate: data.sampleRate,
      channels: 1,
      vbrQuality: data.quality,
    });
    const f32 = toFloat32(new Int16Array(data.pcm));
    const parts: Uint8Array[] = [];
    const a = encoder.encode([f32]);
    if (a.length) parts.push(a.slice());
    const b = encoder.finalize();
    if (b.length) parts.push(b.slice());
    const ogg = concat(parts);
    return { id: data.id, ogg: toTransferableArrayBuffer(ogg) };
  } catch (e) {
    return {
      id: data.id,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type ParentPort = {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
};

let nodeParentPort: ParentPort | null = null;

function post(msg: unknown, transfer?: ArrayBuffer[]) {
  if (isNode) {
    nodeParentPort!.postMessage(msg, transfer ?? []);
  } else {
    // Avoid naming DedicatedWorkerGlobalScope (missing under dnt Node libs).
    g.postMessage!(msg, transfer ?? []);
  }
}

async function boot(): Promise<void> {
  const encoder = await createOggEncoder();

  if (isNode) {
    const { parentPort } = await import("node:worker_threads");
    if (!parentPort) throw new Error("worker_threads parentPort missing");
    nodeParentPort = parentPort as ParentPort;
    parentPort.on("message", (data) => {
      const res = handle(encoder, data);
      if ("ogg" in res) post(res, [res.ogg]);
      else post(res);
    });
  } else {
    g.onmessage = (ev: MessageEvent) => {
      const res = handle(encoder, ev.data);
      if ("ogg" in res) post(res, [res.ogg]);
      else post(res);
    };
  }

  // Signal readiness only after encoder is initialized and handlers are wired.
  post({ ready: true });
}

boot().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    post({ error: `worker boot failed: ${msg}` });
  } catch {
    // parentPort may not be available yet
  }
  throw e;
});
