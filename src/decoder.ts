// Default SF3Decoder: @wasm-audio-decoders/ogg-vorbis (libvorbis WASM) in a
// pool of Web Workers / worker_threads, mirroring createDefaultEncoder().
//
// Each SF3 sample is a complete, independent Ogg Vorbis file (see
// @marmooo/soundfont's Parser.ts, which slices the smpl chunk into one
// self-contained stream per sample), so decodeFile() - which parses a
// whole file and resets the decoder's internal state afterwards - is
// exactly the right call. No manual reset() bookkeeping between samples
// is needed, unlike the streaming decode()/flush() pair.
import {
  type OggVorbisDecodedAudio,
  OggVorbisDecoderWebWorker,
} from "@wasm-audio-decoders/ogg-vorbis";
import type { SF3Decoder, SF3DecodeResult } from "@marmooo/soundfont";

export interface DefaultDecoderOptions {
  // How many worker threads to keep. Defaults to
  // navigator.hardwareConcurrency (or 4). Each concurrent decode occupies
  // one worker; excess decodes queue. Prefer matching write()'s
  // concurrency / the encoder's poolSize.
  poolSize?: number;
}

type DenoGlobal = {
  navigator?: { hardwareConcurrency?: number };
};

function defaultPoolSize(): number {
  const nav = (globalThis as DenoGlobal).navigator;
  return typeof nav !== "undefined" && nav.hardwareConcurrency
    ? nav.hardwareConcurrency
    : 4;
}

type Slot = {
  decoder: OggVorbisDecoderWebWorker;
  busy: boolean;
};

function toInt16(float: Float32Array): Int16Array {
  const pcm = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return pcm;
}

// Creates an SF3Decoder backed by a pool of @wasm-audio-decoders/ogg-vorbis
// workers. Call `dispose()` when finished to terminate workers; otherwise
// they exit with the parent process.
export function createDefaultDecoder(
  options: DefaultDecoderOptions = {},
): SF3Decoder & { dispose?: () => void } {
  const poolSize = Math.max(1, options.poolSize ?? defaultPoolSize());

  const slots: Slot[] = [];
  const waiters: Array<(s: Slot) => void> = [];
  let disposed = false;

  function release(slot: Slot) {
    slot.busy = false;
    const w = waiters.shift();
    if (w) {
      slot.busy = true;
      w(slot);
    }
  }

  function acquire(): Promise<Slot> {
    const free = slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  const readyPromises: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    const decoder = new OggVorbisDecoderWebWorker();
    readyPromises.push(decoder.ready);
    slots.push({ decoder, busy: false });
  }
  const readyPromise = Promise.all(readyPromises).then(() => {});

  const decode: SF3Decoder & { dispose?: () => void } = async (data) => {
    if (disposed) throw new Error("decoder disposed");
    await readyPromise;

    const slot = await acquire();
    try {
      const decoded: OggVorbisDecodedAudio = await slot.decoder.decodeFile(
        data,
      );
      if (decoded.errors.length) {
        // libvorbis recovers from these and keeps decoding, so they aren't
        // fatal - surface the first one so a bad sample isn't silently
        // corrupted without any diagnostic.
        console.error(
          `SF3 sample decode warning: ${decoded.errors[0].message}`,
        );
      }
      const pcm = toInt16(decoded.channelData[0] ?? new Float32Array(0));
      const result: SF3DecodeResult = {
        pcm,
        sampleRate: decoded.sampleRate,
      };
      return result;
    } finally {
      release(slot);
    }
  };

  decode.dispose = () => {
    disposed = true;
    for (const s of slots) {
      // free() is async (it tears down the worker's WASM instance before
      // terminating it); dispose() itself stays sync like the encoder's,
      // so this is fire-and-forget cleanup rather than awaited.
      s.decoder.free().catch(() => {
        /* ignore */
      });
    }
    slots.length = 0;
  };

  return decode;
}
