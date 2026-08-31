import { type SF3Encoder, type SoundFont, write } from "@marmooo/soundfont";
import { createDefaultEncoder, type DefaultEncoderOptions } from "./encoder.ts";

export interface Sf2ToSf3Options extends DefaultEncoderOptions {
  // how many samples to encode concurrently — forwarded to write(). See
  // @marmooo/soundfont's README for the default.
  concurrency?: number;
  // override the default (mediabunny + subprocess) encoder entirely, e.g.
  // to use mediabunny directly in a browser, or a different codec library.
  encode?: SF3Encoder;
}

// Converts a parsed SF2/SF3 SoundFont to SF3 (Ogg Vorbis-compressed
// samples). This is the library entry point — see cli.ts for the
// command-line wrapper around it.
export async function sf2ToSf3(
  soundFont: SoundFont,
  options: Sf2ToSf3Options = {},
): Promise<Uint8Array> {
  const concurrency = options.concurrency;
  const encode = options.encode ??
    createDefaultEncoder({
      bitsPerHz: options.bitsPerHz,
      // Align pool size with write() concurrency so workers stay busy.
      poolSize: concurrency,
      maxUsesPerWorker: options.maxUsesPerWorker,
      maxRetries: options.maxRetries,
    });

  if (!options.encode) {
    // A fresh `node_modules` (e.g. first run, or after cloning) has to be
    // populated from npm before @mediabunny/server can load. If several
    // subprocesses race to do that at once — as concurrent encodes
    // normally would — Deno serializes them with a file lock and prints
    // "Blocking waiting for file lock on node_modules directory", which
    // can look like a hang. Running one throwaway encode alone first
    // populates node_modules once so the real, concurrent batch below
    // never contends for that lock. Skipped for a caller-supplied
    // `encode`, since that's this package's own workaround, not a
    // general one.
    await encode(new Int16Array(1), 44100);
  }

  try {
    return await write(soundFont, { concurrency, encode });
  } finally {
    // Shut down pool workers when we own them.
    if (
      !options.encode &&
      typeof (encode as { dispose?: () => void }).dispose === "function"
    ) {
      (encode as { dispose: () => void }).dispose();
    }
  }
}
