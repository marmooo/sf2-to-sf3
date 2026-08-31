#!/usr/bin/env -S deno run -A --node-modules-dir=auto
/**
 * SF2→SF3 encoder benchmark.
 *
 * Compares:
 *   1. mediabunny (in-process; legacy reference — may be slow / crash-prone)
 *   2. wasm-media-encoders (worker pool) — package default
 *   3. wasm-media-encoders (main-thread, 1 instance)
 *   4. @audio/encode-ogg (main-thread, create/free per sample)
 *
 * Usage (same order as cli.ts):
 *   deno run -A --node-modules-dir=auto bench-sf3-encoders.ts <input.sf2> [quality] [concurrency]
 *
 * quality: WASM VBR −1..10 (default 4). For mediabunny the same number is
 * used as bitsPerHz (different scale — sizes will differ).
 */
import { parse } from "npm:@marmooo/soundfont";
import { sf2ToSf3 } from "../src/mod.ts";
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

const SUPPORTED_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000];

function nearestSupportedRate(rate: number): number {
  let best = SUPPORTED_RATES[0]!;
  for (const candidate of SUPPORTED_RATES) {
    if (Math.abs(candidate - rate) < Math.abs(best - rate)) best = candidate;
  }
  return best;
}

function resampleLinear(
  pcm: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) return pcm;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = Math.round(pcm[i0]! * (1 - frac) + pcm[i1]! * frac);
  }
  return out;
}

/**
 * Legacy mediabunny path (in-process). Kept for comparison only.
 * Not multi-process; concurrent encodes share one process and may stress node-av.
 * Returns { data, sampleRate } when resampling changes the rate.
 */
async function createMediabunnyEncoder(
  bitsPerHz: number,
): Promise<SF3Encoder> {
  const {
    AudioSample,
    AudioSampleSource,
    BufferTarget,
    OggOutputFormat,
    Output,
  } = await import("npm:mediabunny");
  const { registerMediabunnyServer } = await import("npm:@mediabunny/server");
  registerMediabunnyServer();

  return async (pcm, sampleRate) => {
    const targetRate = nearestSupportedRate(sampleRate);
    const samples = resampleLinear(pcm, sampleRate, targetRate);

    const output = new Output({
      format: new OggOutputFormat(),
      target: new BufferTarget(),
    });
    const audioSource = new AudioSampleSource({
      codec: "vorbis",
      bitrate: Math.round(targetRate * bitsPerHz),
    });
    output.addAudioTrack(audioSource);
    await output.start();

    const sample = new AudioSample({
      data: samples,
      format: "s16",
      numberOfChannels: 1,
      sampleRate: targetRate,
      timestamp: 0,
    });
    await audioSource.add(sample);
    sample.close();
    audioSource.close();
    await output.finalize();

    const data = new Uint8Array(output.target.buffer!);
    if (targetRate !== sampleRate) {
      return { data, sampleRate: targetRate };
    }
    return data;
  };
}

async function createWasmMainThreadEncoder(
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
    const a = encoder.encode([f32]);
    if (a.length) parts.push(a.slice());
    const b = encoder.finalize();
    if (b.length) parts.push(b.slice());
    return concat(parts);
  };
}

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
    const enc = await create({ sampleRate, channels: 1, quality });
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
    "usage: deno run -A --node-modules-dir=auto bench-sf3-encoders.ts <input.sf2> [quality] [concurrency]",
  );
  Deno.exit(1);
}

const quality = Number(Deno.args[1] ?? 4);
const concurrency = Math.max(1, Number(Deno.args[2] ?? 4));
const file = Deno.readFileSync(inputPath);

type Case = {
  name: string;
  encode?: SF3Encoder;
  usePackageDefault?: boolean;
  optional?: boolean;
};

const cases: Case[] = [];

// mediabunny — optional (heavy native dep; may fail to load or crash)
try {
  cases.push({
    name: "mediabunny (in-process)",
    encode: await createMediabunnyEncoder(quality),
    optional: true,
  });
} catch (e) {
  console.warn(
    `mediabunny init failed (skipped): ${e instanceof Error ? e.message : e}\n`,
  );
}

cases.push(
  {
    name: "wasm-media-encoders (worker pool)",
    usePackageDefault: true,
  },
  {
    name: "wasm-media-encoders (main-thread)",
    encode: await createWasmMainThreadEncoder(quality),
  },
  {
    name: "@audio/encode-ogg (main-thread)",
    encode: await createAudioEncodeOggEncoder(quality),
  },
);

console.log(
  `input=${inputPath}  quality/bitsPerHz=${quality}  concurrency=${concurrency}\n`,
);

for (const c of cases) {
  try {
    await sf2ToSf3(parse(file), {
      concurrency: 1,
      quality,
      encode: c.usePackageDefault ? undefined : c.encode,
    });

    const t0 = performance.now();
    const out = await sf2ToSf3(parse(file), {
      concurrency,
      quality,
      encode: c.usePackageDefault ? undefined : c.encode,
    });
    const ms = performance.now() - t0;

    console.log(
      `${c.name.padEnd(40)}  ${ms.toFixed(0).padStart(7)} ms  ` +
        `${(out.byteLength / 1024 / 1024).toFixed(2).padStart(7)} MiB`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (c.optional) {
      console.warn(`${c.name.padEnd(40)}  SKIPPED  (${msg})`);
    } else {
      console.error(`${c.name.padEnd(40)}  FAILED   (${msg})`);
      throw e;
    }
  }
}
