// Encodes one PCM sample to Ogg Vorbis in an isolated process. Run as a
// subprocess (see encoder.ts) so that each encode gets fresh native
// (FFmpeg) state; reusing one process for many encodes in a row has been
// observed to crash the native bindings.
//
// The FFmpeg libvorbis encoder used by @mediabunny/server only accepts a
// fixed set of sample rates (8000/11025/16000/22050/32000/44100/48000 Hz)
// and rejects anything else outright, so soundfonts with other sample
// rates (common in real-world SF2s like GeneralUser GS) need resampling
// first. This worker snaps to the nearest supported rate with simple
// linear-interpolation resampling and reports the rate it actually used,
// so the caller can rescale the sample's stored rate and loop points to
// match (see SF3EncodeResult in @marmooo/soundfont).
//
// argv: <sampleRate> <bitsPerHz>
// stdin: raw s16 PCM (mono, little-endian)
// stdout: 4-byte little-endian actual sample rate, followed by Ogg Vorbis
//         bytes
//
// Runs under Deno (`deno run … _vorbis-worker.ts …`) and Node
// (`node _vorbis-worker.js …`) using the same script.
// Top-level await is avoided so dnt can emit CommonJS as well as ESM.
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  OggOutputFormat,
  Output,
} from "mediabunny";
import { registerMediabunnyServer } from "@mediabunny/server";

registerMediabunnyServer();

// the only rates the FFmpeg libvorbis encoder reliably initializes at
const SUPPORTED_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000];

function nearestSupportedRate(rate: number): number {
  let best = SUPPORTED_RATES[0];
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
    out[i] = Math.round(pcm[i0] * (1 - frac) + pcm[i1] * frac);
  }
  return out;
}

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && Array.isArray(d.args);
}

function getArgs(): string[] {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).Deno.args as string[];
  }
  // node: argv[0]=node, argv[1]=script, argv[2]=sampleRate, argv[3]=bitsPerHz
  return process.argv.slice(2);
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function readStdin(): Promise<Uint8Array> {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    // Avoid Response.bytes() — not in the DOM lib dnt uses for type-checking.
    return await readStream(d.stdin.readable);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function writeStdout(data: Uint8Array): Promise<void> {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    await d.stdout.write(data);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }
}

function exit(code: number): never {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.exit(code);
  }
  process.exit(code);
}

async function main(): Promise<void> {
  const [sourceRateArg, bitsPerHzArg] = getArgs();
  const sourceRate = Number(sourceRateArg);
  const bitsPerHz = Number(bitsPerHzArg);
  const pcmBytes = await readStdin();
  const sourcePcm = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength / 2,
  );

  const targetRate = nearestSupportedRate(sourceRate);
  const pcm = resampleLinear(sourcePcm, sourceRate, targetRate);

  const output = new Output({
    format: new OggOutputFormat(),
    target: new BufferTarget(),
  });
  const audioSource = new AudioSampleSource({
    codec: "vorbis",
    // a bitrate proportional to the sample rate; libvorbis's setup rejects
    // fixed high bitrates (like the QUALITY_HIGH preset) at low sample
    // rates because they're not achievable for that Nyquist limit. It also
    // rejects bitrates that are too high for a given rate regardless — keep
    // bitsPerHz roughly in the 2-5 range (see encoder.ts).
    bitrate: Math.round(targetRate * bitsPerHz),
  });
  output.addAudioTrack(audioSource);
  await output.start();

  const sample = new AudioSample({
    data: pcm,
    format: "s16",
    numberOfChannels: 1,
    sampleRate: targetRate,
    timestamp: 0,
  });
  await audioSource.add(sample);
  sample.close();
  audioSource.close();
  await output.finalize();

  const oggBytes = new Uint8Array(output.target.buffer!);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, targetRate, true);
  await writeStdout(header);
  await writeStdout(oggBytes);
}

main()
  .then(() => exit(0))
  .catch((err) => {
    console.error(err);
    exit(1);
  });
