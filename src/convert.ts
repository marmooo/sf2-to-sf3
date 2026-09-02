import {
  type SF3Decoder,
  type SF3Encoder,
  type SoundFont,
  write,
} from "@marmooo/soundfont";
import {
  createDefaultEncoder,
  type DefaultEncoderOptions,
} from "@marmooo/sf3-codec/encoder";
import type { DefaultDecoderOptions } from "@marmooo/sf3-codec/decoder";

export interface Sf2ToSf3Options
  extends DefaultEncoderOptions, DefaultDecoderOptions {
  // how many samples to encode concurrently: forwarded to write().
  concurrency?: number;
  // override the default (wasm-media-encoders worker pool) encoder entirely.
  encode?: SF3Encoder;
  // Re-encode samples that are already compressed (SF3 input) at `quality`
  // too, instead of leaving them at whatever quality they already have.
  // Requires decoding them back to PCM first, which costs extra time; off
  // by default so SF2->SF3 and SF3->SF3 (unchanged quality) stay fast.
  // Ignored when `decode` is given explicitly.
  recompress?: boolean;
  // override the default (@wasm-audio-decoders/ogg-vorbis worker pool)
  // decoder entirely. Implies `recompress`.
  decode?: SF3Decoder;
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

  const useDecoder = Boolean(options.decode ?? options.recompress);
  let decode: (SF3Decoder & { dispose?: () => void }) | undefined;
  if (useDecoder) {
    if (options.decode) {
      decode = options.decode as SF3Decoder & { dispose?: () => void };
    } else {
      // Dynamic import of the decoder *subpath* specifically (not the
      // @marmooo/sf3-codec barrel): the @wasm-audio-decoders/ogg-vorbis
      // dependency (and its embedded WASM) is then only pulled into a
      // bundle - and only fetched at runtime - when recompress/decode is
      // actually used. Encode-only callers never load it.
      const { createDefaultDecoder } = await import(
        "@marmooo/sf3-codec/decoder"
      );
      decode = createDefaultDecoder({
        poolSize: options.poolSize ?? options.concurrency,
      });
    }
  }

  try {
    return await write(soundFont, {
      concurrency: options.concurrency,
      encode,
      decode,
    });
  } finally {
    // Only dispose the pools we created: never a caller-supplied encode/decode.
    if (!options.encode) {
      (encode as SF3Encoder & { dispose?: () => void }).dispose?.();
    }
    if (decode && !options.decode) {
      (decode as SF3Decoder & { dispose?: () => void }).dispose?.();
    }
  }
}
