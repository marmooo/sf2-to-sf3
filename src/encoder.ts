// The default SF3Encoder used by sf2ToSf3() when the caller doesn't supply
// their own. Runs mediabunny + @mediabunny/server (FFmpeg/libvorbis
// bindings) in a subprocess per sample — see _vorbis-worker.ts for why a
// subprocess is needed rather than calling mediabunny directly in-process.
//
// This is one implementation of SF3Encoder (from @marmooo/soundfont), not
// the only way to use sf2ToSf3(): pass your own `encode` in Sf2ToSf3Options
// to use a different encoder (e.g. mediabunny directly in a browser, where
// this subprocess workaround isn't needed).
import type { SF3Encoder } from "@marmooo/soundfont";

export interface DefaultEncoderOptions {
  // bitrate handed to the Vorbis encoder is `sampleRate * bitsPerHz`
  // (bitrate needs to scale with sample rate — see _vorbis-worker.ts).
  // Defaults to 4, which is roughly 176 kbps at 44.1 kHz. Lower (e.g. 2)
  // means smaller/lower quality; libvorbis's encoder setup rejects
  // bitrates that are too high for the sample rate, so values above ~5
  // start failing in testing — stick to roughly 2-5.
  bitsPerHz?: number;
}

// Creates an SF3Encoder that shells out to _vorbis-worker.ts for every
// call. One subprocess per sample is deliberate: reusing a single native
// (FFmpeg) encoder instance for many samples in a row has been observed to
// crash.
export function createDefaultEncoder(
  options: DefaultEncoderOptions = {},
): SF3Encoder {
  const bitsPerHz = options.bitsPerHz ?? 4;
  const workerUrl = new URL("./_vorbis-worker.ts", import.meta.url);

  return async function encode(pcm, sampleRate) {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--node-modules-dir=auto",
        "-A",
        workerUrl.href,
        String(sampleRate),
        String(bitsPerHz),
      ],
      stdin: "piped",
      stdout: "piped",
      // "inherit" would interleave output from concurrent subprocesses;
      // pipe it and forward it after each one finishes instead.
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    );
    await writer.close();
    const { success, stdout, stderr } = await child.output();
    if (stderr.byteLength > 0) {
      await Deno.stderr.write(stderr);
    }
    if (!success) {
      throw new Error("vorbis encode subprocess failed");
    }
    // first 4 bytes: the sample rate the worker actually encoded at (it
    // may have resampled — see _vorbis-worker.ts); the rest is Ogg data.
    const actualSampleRate = new DataView(stdout.buffer).getUint32(0, true);
    return { data: stdout.slice(4), sampleRate: actualSampleRate };
  };
}
