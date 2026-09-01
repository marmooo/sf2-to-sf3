/// <reference lib="deno.worker" />
// Worker side: one dedicated wasm-media-encoders instance per Worker.
// Protocol (main ↔ worker):
//   req:  { id: number, pcm: ArrayBuffer, sampleRate: number, quality: number }
//   res:  { id: number, ogg: ArrayBuffer } | { id: number, error: string }
// pcm / ogg are transferred (zero-copy).
//
// No top-level await (keeps the module CJS-friendly if ever bundled).
import { createOggEncoder } from "wasm-media-encoders";
import type { WasmMediaEncoder } from "wasm-media-encoders";

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

// Ensure we always hand postMessage a real ArrayBuffer (not SharedArrayBuffer).
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
  id: number,
  pcm: ArrayBuffer,
  sampleRate: number,
  quality: number,
): void {
  try {
    encoder.configure({
      sampleRate,
      channels: 1,
      vbrQuality: quality,
    });
    const f32 = toFloat32(new Int16Array(pcm));
    const parts: Uint8Array[] = [];
    const a = encoder.encode([f32]);
    if (a.length) parts.push(a.slice());
    const b = encoder.finalize();
    if (b.length) parts.push(b.slice());
    const ogg = concat(parts);
    const buf = toTransferableArrayBuffer(ogg);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ogg: buf }, [buf]);
  } catch (e) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function boot(): Promise<void> {
  const encoder = await createOggEncoder();

  self.onmessage = (ev: MessageEvent) => {
    const { id, pcm, sampleRate, quality } = ev.data as {
      id: number;
      pcm: ArrayBuffer;
      sampleRate: number;
      quality: number;
    };
    handle(encoder, id, pcm, sampleRate, quality);
  };

  (self as DedicatedWorkerGlobalScope).postMessage({ ready: true });
}

boot();
