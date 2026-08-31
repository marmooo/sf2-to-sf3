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

import { createOggEncoder } from "wasm-media-encoders";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
const isNode = typeof g.Deno === "undefined" &&
  typeof process !== "undefined" &&
  Boolean(process.versions?.node);

const encoder = await createOggEncoder();

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

function handle(
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
    const buf = ogg.buffer.slice(
      ogg.byteOffset,
      ogg.byteOffset + ogg.byteLength,
    );
    return { id: data.id, ogg: buf };
  } catch (e) {
    return {
      id: data.id,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function post(msg: unknown, transfer?: ArrayBuffer[]) {
  if (isNode) {
    // set in boot below
    nodeParentPort!.postMessage(msg, transfer ?? []);
  } else {
    (g as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);
  }
}

// deno-lint-ignore no-explicit-any
let nodeParentPort: any = null;

if (isNode) {
  const { parentPort } = await import("node:worker_threads");
  if (!parentPort) throw new Error("worker_threads parentPort missing");
  nodeParentPort = parentPort;
  parentPort.on("message", (data) => {
    const res = handle(data);
    if ("ogg" in res) post(res, [res.ogg]);
    else post(res);
  });
  post({ ready: true });
} else {
  g.onmessage = (ev: MessageEvent) => {
    const res = handle(ev.data);
    if ("ogg" in res) post(res, [res.ogg]);
    else post(res);
  };
  post({ ready: true });
}
