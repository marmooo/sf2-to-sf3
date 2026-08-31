// The default SF3Encoder used by sf2ToSf3() when the caller doesn't supply
// their own. Runs mediabunny + @mediabunny/server (FFmpeg/libvorbis
// bindings) in a subprocess per sample — see _vorbis-worker.ts for why a
// subprocess is needed rather than calling mediabunny directly in-process.
//
// This is one implementation of SF3Encoder (from @marmooo/soundfont), not
// the only way to use sf2ToSf3(): pass your own `encode` in Sf2ToSf3Options
// to use a different encoder (e.g. mediabunny directly in a browser, where
// this subprocess workaround isn't needed).
//
// Spawning uses node:child_process so the same code path works under both
// Deno (Node-compat) and Node. Deno.Command is avoided because @deno/dnt's
// Deno shim does not type/support it yet.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && typeof d.execPath === "function";
}

function resolveWorkerPath(): string {
  // Match this module's extension: source tree is .ts, dnt/npm output is .js.
  // Do not key off isDenoRuntime() — Deno loading the npm package still needs .js.
  const self = import.meta.url;
  const workerRel = self.endsWith(".ts")
    ? "./_vorbis-worker.ts"
    : "./_vorbis-worker.js";
  const workerUrl = new URL(workerRel, self);

  if (isDenoRuntime()) {
    // deno run accepts a file URL
    return workerUrl.href;
  }
  return fileURLToPath(workerUrl);
}

function writeStderr(data: Uint8Array): void {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    d.stderr.writeSync(data);
  } else {
    process.stderr.write(data);
  }
}

// Creates an SF3Encoder that shells out to _vorbis-worker for every call.
// One subprocess per sample is deliberate: reusing a single native (FFmpeg)
// encoder instance for many samples in a row has been observed to crash.
export function createDefaultEncoder(
  options: DefaultEncoderOptions = {},
): SF3Encoder {
  const bitsPerHz = options.bitsPerHz ?? 4;
  const workerPath = resolveWorkerPath();

  return async function encode(pcm, sampleRate) {
    const deno = isDenoRuntime();
    // deno-lint-ignore no-explicit-any
    const cmd = deno ? (globalThis as any).Deno.execPath() : process.execPath;
    const args = deno
      ? [
        "run",
        "--node-modules-dir=auto",
        "-A",
        workerPath,
        String(sampleRate),
        String(bitsPerHz),
      ]
      : [workerPath, String(sampleRate), String(bitsPerHz)];

    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: avoid wrapping in cmd.exe
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    const pcmBytes = new Uint8Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength,
    );
    child.stdin!.write(pcmBytes);
    child.stdin!.end();

    const code = await exitPromise;

    if (stderrChunks.length > 0) {
      writeStderr(Buffer.concat(stderrChunks));
    }
    if (code !== 0) {
      throw new Error("vorbis encode subprocess failed");
    }

    const stdout = Buffer.concat(stdoutChunks);
    // first 4 bytes: the sample rate the worker actually encoded at (it
    // may have resampled — see _vorbis-worker.ts); the rest is Ogg data.
    const actualSampleRate = stdout.readUInt32LE(0);
    return {
      data: new Uint8Array(stdout.subarray(4)),
      sampleRate: actualSampleRate,
    };
  };
}
