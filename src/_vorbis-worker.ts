// Encodes one PCM sample to Ogg Vorbis in an isolated process. Run as a
// subprocess (see sf2-to-sf3.ts) so that each encode gets fresh native
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
// match (see SF3EncodeResult in ../src/Writer.ts).
//
// argv: <sampleRate> <bitsPerHz>
// stdin: raw s16 PCM (mono, little-endian)
// stdout: 4-byte little-endian actual sample rate, followed by Ogg Vorbis
//         bytes
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

const sourceRate = Number(Deno.args[0]);
const bitsPerHz = Number(Deno.args[1]);
const pcmBytes = await new Response(Deno.stdin.readable).bytes();
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
  // bitsPerHz roughly in the 2-5 range (see sf2-to-sf3.ts).
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
await Deno.stdout.write(header);
await Deno.stdout.write(oggBytes);
Deno.exit(0);
