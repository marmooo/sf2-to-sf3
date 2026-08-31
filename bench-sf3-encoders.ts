#!/usr/bin/env -S deno run -A --node-modules-dir=auto
/**
 * SF2→SF3 encoder benchmark (single file).
 *
 * Compares:
 *   1. mediabunny (default pool in @marmooo/sf2-to-sf3)
 *   2. wasm-media-encoders (direct)
 *   3. @audio/encode-ogg (wrapper over wasm-media-encoders)
 *
 * Usage:
 *   deno run -A --node-modules-dir=auto bench-sf3-encoders.ts <input.sf2> [concurrency] [quality]
 *
 * quality: Vorbis VBR for WASM backends (−1..10, default 3).
 *          mediabunny always uses bitsPerHz=4 (quality arg ignored).
 */
import { parse } from "npm:@marmooo/soundfont";
import { sf2ToSf3 } from "npm:@marmooo/sf2-to-sf3";
import type { SF3Encoder } from "npm:@marmooo/soundfont";

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

/** wasm-media-encoders — one long-lived instance, configure() per sample. */
async function createWasmMediaEncodersEncoder(
  quality: number,
): Promise<SF3Encoder> {
  const { createOggEncoder } = await import("npm:wasm-media-encoders");
  const encoder = await createOggEncoder();

  return async (pcm, sampleRate) => {
    encoder.configure({
      sampleRate,
      channels: 1,
      vbrQuality: quality,
    });
    const f32 = toFloat32(pcm);
    const parts: Uint8Array[] = [];
    // returned buffers are owned by the encoder — must copy
    const a = encoder.encode([f32]);
    if (a.length) parts.push(a.slice());
    const b = encoder.finalize();
    if (b.length) parts.push(b.slice());
    return concat(parts);
  };
}

/** @audio/encode-ogg — create/free per sample (API default style). */
async function createAudioEncodeOggEncoder(
  quality: number,
): Promise<SF3Encoder> {
  const create = (await import("npm:@audio/encode-ogg")).default as (
    opts: { sampleRate: number; channels?: number; quality?: number },
  ) => Promise<{
    encode: (channelData: Float32Array[]) => Uint8Array;
    flush: () => Uint8Array;
    free?: () => void;
  }>;

  return async (pcm, sampleRate) => {
    const enc = await create({
      sampleRate,
      channels: 1,
      quality,
    });
    try {
      const f32 = toFloat32(pcm);
      const a = enc.encode([f32]);
      const b = enc.flush();
      return concat([
        a?.byteLength ? a : new Uint8Array(0),
        b?.byteLength ? b : new Uint8Array(0),
      ]);
    } finally {
      enc.free?.();
    }
  };
}

const inputPath = Deno.args[0];
if (!inputPath) {
  console.error(
    "usage: deno run -A --node-modules-dir=auto bench-sf3-encoders.ts <input.sf2> [concurrency] [quality]",
  );
  Deno.exit(1);
}

const concurrency = Math.max(1, Number(Deno.args[1] ?? 4));
const quality = Number(Deno.args[2] ?? 3);
const file = Deno.readFileSync(inputPath);

type Case = {
  name: string;
  encode?: SF3Encoder;
};

const cases: Case[] = [
  { name: "mediabunny (default)" },
  {
    name: "wasm-media-encoders",
    encode: await createWasmMediaEncodersEncoder(quality),
  },
  {
    name: "@audio/encode-ogg",
    encode: await createAudioEncodeOggEncoder(quality),
  },
];

console.log(
  `input=${inputPath}  concurrency=${concurrency}  ` +
    `quality(WASM −1..10)=${quality}  bitsPerHz(mediabunny)=4\n`,
);

for (const c of cases) {
  // warm-up (WASM compile / node_modules lock / mediabunny throwaway)
  await sf2ToSf3(parse(file), {
    concurrency: 1,
    encode: c.encode,
    bitsPerHz: 4,
  });

  const t0 = performance.now();
  const out = await sf2ToSf3(parse(file), {
    concurrency,
    encode: c.encode,
    bitsPerHz: 4,
  });
  const ms = performance.now() - t0;

  console.log(
    `${c.name.padEnd(24)}  ${ms.toFixed(0).padStart(7)} ms  ` +
      `${(out.byteLength / 1024 / 1024).toFixed(2).padStart(7)} MiB`,
  );
}
