import { type SF3Encoder, type SoundFont, write } from "@marmooo/soundfont";
import { createDefaultEncoder, type DefaultEncoderOptions } from "./encoder.ts";

export interface Sf2ToSf3Options extends DefaultEncoderOptions {
  // how many samples to encode concurrently: forwarded to write().
  concurrency?: number;
  // override the default (wasm-media-encoders worker pool) encoder entirely.
  encode?: SF3Encoder;
}

// Converts a parsed SF2/SF3 SoundFont to SF3 (Ogg Vorbis-compressed samples).
export async function sf2ToSf3(
  soundFont: SoundFont,
  options: Sf2ToSf3Options = {},
): Promise<Uint8Array> {
  const encode = options.encode ??
    createDefaultEncoder({
      quality: options.quality,
      // Keep pool size in sync with write() concurrency when the caller sets it.
      poolSize: options.poolSize ?? options.concurrency,
    });

  try {
    return await write(soundFont, {
      concurrency: options.concurrency,
      encode,
    });
  } finally {
    // Only dispose the pool we created: never a caller-supplied encode.
    if (!options.encode) {
      (encode as SF3Encoder & { dispose?: () => void }).dispose?.();
    }
  }
}
